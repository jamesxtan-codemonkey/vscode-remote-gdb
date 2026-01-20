import {
    MIRecord,
    MIRecordType,
    MIResult,
    MIValue,
    MITuple,
    MIList,
    GDBBreakpoint,
    GDBStackFrame,
    GDBVariable,
    GDBStoppedEvent,
    StopReason
} from './types/gdb';
import { logger } from './utils/logger';

/**
 * GDB/MI Protocol Parser and Command Generator
 */
export class GDBMI {
    private tokenCounter = 1000;

    /**
     * Generate next command token
     */
    getNextToken(): number {
        return this.tokenCounter++;
    }

    /**
     * Parse GDB/MI output line
     */
    parseLine(line: string): MIRecord | null {
        if (!line || line.trim().length === 0) {
            return null;
        }

        const trimmed = line.trim();

        // Parse token (if present)
        let token: number | undefined;
        let rest = trimmed;
        const tokenMatch = /^(\d+)(.*)$/.exec(trimmed);
        if (tokenMatch) {
            token = parseInt(tokenMatch[1], 10);
            rest = tokenMatch[2];
        }

        // Determine record type and parse
        if (rest.startsWith('^')) {
            // Result record
            return this.parseResultRecord(rest, token);
        } else if (rest.startsWith('*')) {
            // Exec async record
            return this.parseAsyncRecord(rest, 'exec', token);
        } else if (rest.startsWith('+')) {
            // Status async record
            return this.parseAsyncRecord(rest, 'status', token);
        } else if (rest.startsWith('=')) {
            // Notify async record
            return this.parseAsyncRecord(rest, 'notify', token);
        } else if (rest.startsWith('~')) {
            // Console stream
            return this.parseStreamRecord(rest, 'console');
        } else if (rest.startsWith('@')) {
            // Target stream
            return this.parseStreamRecord(rest, 'target');
        } else if (rest.startsWith('&')) {
            // Log stream
            return this.parseStreamRecord(rest, 'log');
        } else if (rest === '(gdb)') {
            // GDB prompt - ignore
            return null;
        }

        logger.debug('Unparsed GDB/MI line', { line });
        return null;
    }

    /**
     * Parse result record (^done, ^error, etc.)
     */
    private parseResultRecord(line: string, token?: number): MIRecord {
        const match = /^\^([a-z-]+),?(.*)$/.exec(line);
        if (!match) {
            return { type: 'result', token };
        }

        const resultClass = match[1];
        const resultsStr = match[2];

        return {
            type: 'result',
            token,
            class: resultClass as any,
            results: resultsStr ? this.parseResults(resultsStr) : []
        };
    }

    /**
     * Parse async record (*, +, =)
     */
    private parseAsyncRecord(line: string, type: MIRecordType, token?: number): MIRecord {
        const match = /^[*+=]([a-z-]+),?(.*)$/.exec(line);
        if (!match) {
            return { type, token };
        }

        const asyncClass = match[1];
        const resultsStr = match[2];

        return {
            type,
            token,
            class: asyncClass as any,
            results: resultsStr ? this.parseResults(resultsStr) : []
        };
    }

    /**
     * Parse stream record (~, @, &)
     */
    private parseStreamRecord(line: string, type: MIRecordType): MIRecord {
        const match = /^[~@&]"(.*)"$/.exec(line);
        if (!match) {
            return { type, output: line.substring(1) };
        }

        return {
            type,
            output: this.unescapeString(match[1])
        };
    }

    /**
     * Parse results (comma-separated key=value pairs)
     */
    private parseResults(str: string): MIResult[] {
        const results: MIResult[] = [];
        let i = 0;

        while (i < str.length) {
            // Skip whitespace and commas
            while (i < str.length && (str[i] === ' ' || str[i] === ',')) {
                i++;
            }
            if (i >= str.length) {
                break;
            }

            // Parse variable name
            const varMatch = /^([a-zA-Z_][a-zA-Z0-9_-]*)=/.exec(str.substring(i));
            if (!varMatch) {
                break;
            }

            const variable = varMatch[1];
            i += varMatch[0].length;

            // Parse value
            const { value, endIndex } = this.parseValue(str, i);
            i = endIndex;

            results.push({ variable, value });
        }

        return results;
    }

    /**
     * Parse a value (string, tuple, or list)
     */
    private parseValue(str: string, startIndex: number): { value: MIValue; endIndex: number } {
        let i = startIndex;

        if (str[i] === '"') {
            // String value
            i++; // Skip opening quote
            let escaped = false;
            let value = '';

            while (i < str.length) {
                if (escaped) {
                    value += str[i];
                    escaped = false;
                } else if (str[i] === '\\') {
                    escaped = true;
                } else if (str[i] === '"') {
                    i++; // Skip closing quote
                    return { value: this.unescapeString(value), endIndex: i };
                } else {
                    value += str[i];
                }
                i++;
            }

            return { value, endIndex: i };
        } else if (str[i] === '{') {
            // Tuple value
            i++; // Skip opening brace
            const results: MIResult[] = [];

            while (i < str.length && str[i] !== '}') {
                // Skip whitespace and commas
                while (i < str.length && (str[i] === ' ' || str[i] === ',')) {
                    i++;
                }
                if (i >= str.length || str[i] === '}') {
                    break;
                }

                // Parse variable=value
                const varMatch = /^([a-zA-Z_][a-zA-Z0-9_-]*)=/.exec(str.substring(i));
                if (varMatch) {
                    const variable = varMatch[1];
                    i += varMatch[0].length;

                    const { value, endIndex } = this.parseValue(str, i);
                    i = endIndex;

                    results.push({ variable, value });
                }
            }

            i++; // Skip closing brace
            return { value: { type: 'tuple', results }, endIndex: i };
        } else if (str[i] === '[') {
            // List value
            i++; // Skip opening bracket
            const values: MIValue[] = [];

            while (i < str.length && str[i] !== ']') {
                // Skip whitespace and commas
                while (i < str.length && (str[i] === ' ' || str[i] === ',')) {
                    i++;
                }
                if (i >= str.length || str[i] === ']') {
                    break;
                }

                const prevIndex = i;

                // Check if this is a named value (like "frame={...}")
                const namedMatch = /^([a-zA-Z_][a-zA-Z0-9_-]*)=/.exec(str.substring(i));
                if (namedMatch) {
                    // This is a result, not just a value - parse it as a tuple
                    const variable = namedMatch[1];
                    i += namedMatch[0].length;
                    const { value, endIndex } = this.parseValue(str, i);
                    i = endIndex;
                    // Wrap in tuple format
                    values.push({ type: 'tuple', results: [{ variable, value }] });
                } else {
                    const { value, endIndex } = this.parseValue(str, i);
                    i = endIndex;
                    values.push(value);
                }

                // Prevent infinite loop
                if (i === prevIndex) {
                    logger.error('Parser stuck at same position', { position: i, char: str[i], context: str.substring(i, i + 20) });
                    break;
                }
            }

            i++; // Skip closing bracket
            return { value: { type: 'list', values }, endIndex: i };
        }

        // Fallback: read until comma or end
        let value = '';
        while (i < str.length && str[i] !== ',' && str[i] !== '}' && str[i] !== ']') {
            value += str[i];
            i++;
        }

        return { value: value.trim(), endIndex: i };
    }

    /**
     * Unescape string
     */
    private unescapeString(str: string): string {
        return str
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }

    /**
     * Find result value by variable name
     */
    findResult(results: MIResult[] | undefined, variable: string): MIValue | undefined {
        if (!results) {
            return undefined;
        }
        const result = results.find(r => r.variable === variable);
        return result?.value;
    }

    /**
     * Get string value from result
     */
    getStringValue(value: MIValue | undefined): string | undefined {
        if (typeof value === 'string') {
            return value;
        }
        return undefined;
    }

    /**
     * Get tuple from result
     */
    getTuple(value: MIValue | undefined): MITuple | undefined {
        if (value && typeof value === 'object' && 'type' in value && value.type === 'tuple') {
            return value;
        }
        return undefined;
    }

    /**
     * Get list from result
     */
    getList(value: MIValue | undefined): MIList | undefined {
        if (value && typeof value === 'object' && 'type' in value && value.type === 'list') {
            return value;
        }
        return undefined;
    }

    /**
     * Parse stopped event
     */
    parseStoppedEvent(results: MIResult[]): GDBStoppedEvent {
        const reason = this.getStringValue(this.findResult(results, 'reason')) as StopReason || 'signal-received';
        const threadIdStr = this.getStringValue(this.findResult(results, 'thread-id'));
        const threadId = threadIdStr ? parseInt(threadIdStr, 10) : undefined;
        const bkptnoStr = this.getStringValue(this.findResult(results, 'bkptno'));
        const breakpointId = bkptnoStr ? parseInt(bkptnoStr, 10) : undefined;
        const signal = this.getStringValue(this.findResult(results, 'signal-name'));
        const exitCodeStr = this.getStringValue(this.findResult(results, 'exit-code'));
        const exitCode = exitCodeStr ? parseInt(exitCodeStr, 10) : undefined;

        const frameTuple = this.getTuple(this.findResult(results, 'frame'));
        const frame = frameTuple ? this.parseStackFrame(frameTuple) : undefined;

        return {
            reason,
            threadId,
            breakpointId,
            signal,
            exitCode,
            frame
        };
    }

    /**
     * Parse stack frame from tuple
     */
    parseStackFrame(tuple: MITuple): GDBStackFrame {
        const levelStr = this.getStringValue(this.findResult(tuple.results, 'level'));
        const level = levelStr ? parseInt(levelStr, 10) : 0;
        const addr = this.getStringValue(this.findResult(tuple.results, 'addr')) || '0x0';
        const func = this.getStringValue(this.findResult(tuple.results, 'func')) || '??';
        const file = this.getStringValue(this.findResult(tuple.results, 'file'));
        const fullname = this.getStringValue(this.findResult(tuple.results, 'fullname'));
        const lineStr = this.getStringValue(this.findResult(tuple.results, 'line'));
        const line = lineStr ? parseInt(lineStr, 10) : undefined;

        return { level, addr, func, file, fullname, line };
    }

    /**
     * Generate MI command
     */
    command(cmd: string, args?: string): string {
        const token = this.getNextToken();
        if (args) {
            return `${token}-${cmd} ${args}`;
        }
        return `${token}-${cmd}`;
    }
}
