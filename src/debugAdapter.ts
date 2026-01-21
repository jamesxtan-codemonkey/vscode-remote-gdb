import {
    DebugSession,
    InitializedEvent,
    TerminatedEvent,
    StoppedEvent,
    OutputEvent,
    Thread,
    StackFrame,
    Scope,
    Source,
    Handles,
    Breakpoint
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Client, ClientChannel } from 'ssh2';
import { RemoteGDBConfiguration } from './types/config';
import { SSHManager } from './sshManager';
import { ConfigParser } from './configParser';
import { GDBMI } from './gdbMI';
import { PathMapper } from './utils/pathMapper';
import { logger } from './utils/logger';
import { MIRecord, MITuple } from './types/gdb';

/**
 * Remote GDB Debug Adapter
 */
export class RemoteGDBDebugSession extends DebugSession {
    private sshManager: SSHManager;
    private configParser: ConfigParser;
    private gdbMI: GDBMI;
    private pathMapper: PathMapper | null = null;
    private sshClient: Client | null = null;
    private gdbChannel: ClientChannel | null = null;
    private configuration: RemoteGDBConfiguration | null = null;
    private variableHandles = new Handles<string>();
    private breakpoints: Map<string, DebugProtocol.Breakpoint[]> = new Map();
    private gdbBreakpoints: Map<string, Map<number, number>> = new Map(); // File -> (VSCode line -> GDB breakpoint ID)
    private currentThreadId = 1;
    private outputBuffer = '';
    private isRunning = false;
    private isInitialized = false;
    private gdbReady = false;
    private pendingBreakpoints: Map<string, DebugProtocol.SourceBreakpoint[]> = new Map();
    private pendingCommands: Map<number, { resolve: (record: MIRecord) => void; reject: (error: Error) => void }> = new Map();
    private pendingStackTrace: Promise<MIRecord> | null = null;

    constructor() {
        super();
        this.sshManager = new SSHManager();
        this.configParser = new ConfigParser();
        this.gdbMI = new GDBMI();

        // Listen for SSH disconnection events
        this.sshManager.on('disconnected', (host: string) => {
            logger.warn('SSH connection lost', { host });
            this.sendEvent(new OutputEvent(`SSH connection lost to ${host}\n`, 'console'));
        });

        this.sshManager.on('reconnected', (host: string) => {
            logger.info('SSH connection restored', { host });
            this.sendEvent(new OutputEvent(`SSH connection restored to ${host}\n`, 'console'));
        });

        this.sshManager.on('reconnectFailed', (host: string) => {
            logger.error('Failed to reconnect to SSH host', { host });
            this.sendEvent(new OutputEvent(`Failed to reconnect to ${host}. Debug session terminated.\n`, 'stderr'));
            this.sendEvent(new TerminatedEvent());
        });
    }

    /**
     * Override dispatchRequest to log all incoming requests
     */
    protected dispatchRequest(request: DebugProtocol.Request): void {
        logger.info(`>>> Received request: ${request.command}`, {
            command: request.command,
            seq: request.seq
        });

        // Special handling for setBreakpoints to debug why it's not working
        if (request.command === 'setBreakpoints') {
            logger.info('!!! setBreakpoints request detected in dispatchRequest, manually handling');
            const args = request.arguments as DebugProtocol.SetBreakpointsArguments;
            const response: DebugProtocol.SetBreakpointsResponse = {
                request_seq: request.seq,
                seq: 0,
                type: 'response',
                command: request.command,
                success: true,
                body: { breakpoints: [] }
            };
            this.setBreakpointsRequest(response, args);
            return;
        }

        super.dispatchRequest(request);
    }

    /**
     * Initialize request
     */
    protected initializeRequest(
        response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments
    ): void {
        logger.info('Initialize request received', args);

        response.body = {
            supportsConfigurationDoneRequest: true,
            supportsEvaluateForHovers: true,
            supportsStepBack: false,
            supportsSetVariable: false,
            supportsRestartFrame: false,
            supportsConditionalBreakpoints: false,
            supportsHitConditionalBreakpoints: false,
            supportsFunctionBreakpoints: false,
            supportsDataBreakpoints: false,
            supportsTerminateRequest: true,
            supportsBreakpointLocationsRequest: false
        };

        this.sendResponse(response);
        logger.info('Sending InitializedEvent to signal VSCode can send breakpoints');
        this.sendEvent(new InitializedEvent());
        logger.info('InitializedEvent sent');
    }

    /**
     * Launch request
     */
    protected async launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: DebugProtocol.LaunchRequestArguments
    ): Promise<void> {
        const remoteArgs = args as unknown as RemoteGDBConfiguration;
        logger.info('Launch request received', remoteArgs);
        this.configuration = remoteArgs;

        // Set verbose logging if requested
        if (remoteArgs.verbose) {
            logger.setVerbose(true);
        }

        // Initialize path mapper
        this.pathMapper = new PathMapper(remoteArgs.sourceMap);

        try {
            // Connect to SSH
            const sshDetails = this.configParser.getConnectionDetails(remoteArgs.sshHost, {
                hostname: remoteArgs.sshHostname,
                port: remoteArgs.sshPort,
                username: remoteArgs.sshUsername,
                privateKeyPath: remoteArgs.sshKeyFile
            });

            logger.info('Connecting to SSH host');
            this.sshClient = await this.sshManager.connect(sshDetails, remoteArgs.timeout || 10000);
            logger.info('SSH client connected');

            // Now start GDB
            logger.info('Starting GDB before sending launch response');
            await this.startGDB(remoteArgs);
            logger.info('GDB started successfully');

            this.isInitialized = true;
            logger.info('Debug session initialized, ready for configuration done');

            this.sendResponse(response);
        } catch (error) {
            logger.error('Launch failed', error);
            this.sendErrorResponse(response, {
                id: 1,
                format: `Failed to launch: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    /**
     * Attach request
     */
    protected async attachRequest(
        response: DebugProtocol.AttachResponse,
        args: DebugProtocol.AttachRequestArguments
    ): Promise<void> {
        const remoteArgs = args as unknown as RemoteGDBConfiguration;
        logger.info('Attach request received', remoteArgs);
        this.configuration = remoteArgs;

        // Set verbose logging if requested
        if (remoteArgs.verbose) {
            logger.setVerbose(true);
        }

        // Initialize path mapper
        this.pathMapper = new PathMapper(remoteArgs.sourceMap);

        try {
            // Connect to SSH
            const sshDetails = this.configParser.getConnectionDetails(remoteArgs.sshHost, {
                hostname: remoteArgs.sshHostname,
                port: remoteArgs.sshPort,
                username: remoteArgs.sshUsername,
                privateKeyPath: remoteArgs.sshKeyFile
            });

            this.sshClient = await this.sshManager.connect(sshDetails, remoteArgs.timeout || 10000);

            // Start GDB and attach
            await this.startGDB(remoteArgs);
            await this.attachToProcess(remoteArgs.processId!);

            this.isInitialized = true;
            this.sendResponse(response);
        } catch (error) {
            logger.error('Attach failed', error);
            this.sendErrorResponse(response, {
                id: 2,
                format: `Failed to attach: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    /**
     * Start GDB on remote machine
     */
    private async startGDB(config: RemoteGDBConfiguration): Promise<void> {
        if (!this.sshClient) {
            throw new Error('SSH client not connected');
        }

        const gdbPath = config.gdbPath || '/usr/bin/gdb';
        let gdbCommand = `${gdbPath} --interpreter=mi ${config.program}`;

        // Add core dump if specified
        if (config.coreDumpPath) {
            gdbCommand += ` ${config.coreDumpPath}`;
        }

        logger.info('Starting GDB', { command: gdbCommand });

        try {
            this.gdbChannel = await this.sshManager.spawnProcess(this.sshClient, gdbCommand);
            logger.info('GDB channel created successfully');
        } catch (error) {
            logger.error('Failed to spawn GDB process', error);
            throw error;
        }

        // Setup GDB output handlers
        logger.info('Setting up GDB output handlers');
        this.gdbChannel.on('data', (data: Buffer) => {
            logger.info('GDB stdout data event fired');
            this.handleGDBOutput(data.toString());
        });

        this.gdbChannel.stderr.on('data', (data: Buffer) => {
            logger.error('GDB stderr', { output: data.toString() });
            this.sendEvent(new OutputEvent(data.toString(), 'stderr'));
        });

        this.gdbChannel.on('close', () => {
            logger.info('GDB process closed');
            this.sendEvent(new TerminatedEvent());
        });

        logger.info('GDB output handlers registered');

        // Wait for GDB to be ready
        await this.waitForGDBPrompt();

        // Execute setup commands
        if (config.setupCommands && config.setupCommands.length > 0) {
            for (const cmd of config.setupCommands) {
                try {
                    await this.sendGDBCommand(cmd);
                } catch (error) {
                    logger.warn('Setup command failed', { cmd, error });
                }
            }
        }

        // Set working directory if specified (use gdb-set cwd for MI)
        if (config.cwd && !config.coreDumpPath) {
            try {
                await this.sendGDBCommand(`gdb-set cwd ${config.cwd}`);
            } catch (error) {
                logger.warn('Failed to set working directory', { cwd: config.cwd, error });
            }
        }

        // Set environment variables (use gdb-set environment for MI)
        if (config.env && !config.coreDumpPath) {
            for (const [key, value] of Object.entries(config.env)) {
                try {
                    await this.sendGDBCommand(`gdb-set environment ${key} ${value}`);
                } catch (error) {
                    logger.warn('Failed to set environment variable', { key, value, error });
                }
            }
        }

        // Set arguments
        if (config.args && config.args.length > 0 && !config.coreDumpPath) {
            try {
                const argsStr = config.args.join(' ');
                await this.sendGDBCommand(`exec-arguments ${argsStr}`);
            } catch (error) {
                logger.warn('Failed to set arguments', { args: config.args, error });
            }
        }
    }

    /**
     * Attach to process
     */
    private async attachToProcess(processId: string | number): Promise<void> {
        const pid = typeof processId === 'string' ? parseInt(processId, 10) : processId;
        logger.info('Attaching to process', { pid });
        await this.sendGDBCommand(`target-attach ${pid}`);
    }

    /**
     * Wait for GDB prompt
     */
    private waitForGDBPrompt(): Promise<void> {
        logger.info('Waiting for GDB prompt...');
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                logger.error('Timeout waiting for GDB prompt', {
                    gdbReady: this.gdbReady
                });
                reject(new Error('Timeout waiting for GDB prompt'));
            }, 5000);

            const checkPrompt = () => {
                if (this.gdbReady) {
                    clearTimeout(timeout);
                    logger.info('GDB prompt received');
                    resolve();
                } else {
                    setTimeout(checkPrompt, 100);
                }
            };
            checkPrompt();
        });
    }

    /**
     * Handle GDB output
     */
    private handleGDBOutput(data: string): void {
        logger.info('GDB output received', { data, length: data.length });
        this.outputBuffer += data;
        logger.gdbResponse(data);

        // Check for GDB prompt to mark as ready
        if (data.includes('(gdb)')) {
            logger.info('GDB prompt detected, marking as ready');
            this.gdbReady = true;
        }

        const lines = this.outputBuffer.split('\n');
        this.outputBuffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
            const record = this.gdbMI.parseLine(line);
            if (record) {
                this.handleMIRecord(record);
            }
        }
    }

    /**
     * Handle MI record
     */
    private handleMIRecord(record: MIRecord): void {
        switch (record.type) {
            case 'result':
                // Result records are handled by command responses
                if (record.token !== undefined) {
                    const pending = this.pendingCommands.get(record.token);
                    if (pending) {
                        this.pendingCommands.delete(record.token);
                        if (record.class === 'done' || record.class === 'running') {
                            pending.resolve(record);
                        } else if (record.class === 'error') {
                            const msg = this.gdbMI.getStringValue(this.gdbMI.findResult(record.results, 'msg'));
                            pending.reject(new Error(msg || 'GDB command failed'));
                        } else {
                            pending.resolve(record);
                        }
                    }
                }
                break;

            case 'exec':
                if (record.class === 'stopped') {
                    this.isRunning = false;
                    const stoppedEvent = this.gdbMI.parseStoppedEvent(record.results || []);
                    this.handleStopped(stoppedEvent);
                } else if (record.class === 'running') {
                    this.isRunning = true;
                }
                break;

            case 'console':
            case 'target':
                // Program output
                if (record.output) {
                    this.sendEvent(new OutputEvent(record.output, 'stdout'));
                }
                break;

            case 'log':
                // GDB log output
                if (record.output) {
                    logger.debug('GDB log', { output: record.output });
                }
                break;
        }
    }

    /**
     * Handle stopped event
     */
    private handleStopped(event: any): void {
        logger.info('Program stopped', event);

        // Handle program exit
        if (event.reason === 'exited-normally' || event.reason === 'exited') {
            logger.info('Program exited, terminating debug session');
            this.sendEvent(new TerminatedEvent());
            return;
        }

        let reason: 'breakpoint' | 'step' | 'pause' | 'exception' | 'entry' = 'pause';
        if (event.reason === 'breakpoint-hit') {
            reason = 'breakpoint';
        } else if (event.reason === 'end-stepping-range') {
            reason = 'step';
        } else if (event.reason === 'signal-received') {
            reason = 'exception';
        }

        this.sendEvent(new StoppedEvent(reason, this.currentThreadId));
    }

    /**
     * Send GDB command
     */
    private async sendGDBCommand(command: string): Promise<MIRecord> {
        if (!this.gdbChannel) {
            throw new Error('GDB channel not available');
        }

        const token = this.gdbMI.getNextToken();
        const parts = command.split(' ');
        const cmd = parts[0];
        const args = parts.slice(1).join(' ');
        const fullCmd = args ? `${token}-${cmd} ${args}` : `${token}-${cmd}`;

        logger.info('Sending GDB command', { command, formatted: fullCmd, token });
        logger.gdbCommand(fullCmd);

        return new Promise((resolve, reject) => {
            this.pendingCommands.set(token, { resolve, reject });

            // Set a timeout
            setTimeout(() => {
                if (this.pendingCommands.has(token)) {
                    this.pendingCommands.delete(token);
                    reject(new Error(`Command timeout: ${command}`));
                }
            }, 5000);

            this.gdbChannel!.write(fullCmd + '\n');
        });
    }

    private rememberGdbBreakpoint(path: string, line: number | undefined, gdbId: number): void {
        if (line === undefined) {
            return;
        }
        let fileBreakpoints = this.gdbBreakpoints.get(path);
        if (!fileBreakpoints) {
            fileBreakpoints = new Map();
            this.gdbBreakpoints.set(path, fileBreakpoints);
        }
        fileBreakpoints.set(line, gdbId);
    }

    private getGdbBreakpointId(record: MIRecord): number | undefined {
        const bkptValue = this.gdbMI.findResult(record.results, 'bkpt');
        if (!bkptValue) {
            return undefined;
        }

        const tuple = this.gdbMI.getTuple(bkptValue);
        if (tuple) {
            return this.getGdbBreakpointNumberFromTuple(tuple);
        }

        const list = this.gdbMI.getList(bkptValue);
        if (list) {
            for (const value of list.values) {
                const listTuple = this.gdbMI.getTuple(value);
                if (listTuple) {
                    const number = this.getGdbBreakpointNumberFromTuple(listTuple);
                    if (number !== undefined) {
                        return number;
                    }
                }
            }
        }

        return undefined;
    }

    private getGdbBreakpointNumberFromTuple(tuple: MITuple): number | undefined {
        const numberStr = this.gdbMI.getStringValue(this.gdbMI.findResult(tuple.results, 'number'));
        if (!numberStr) {
            return undefined;
        }
        const parsed = parseInt(numberStr, 10);
        return Number.isNaN(parsed) ? undefined : parsed;
    }

    /**
     * Configuration done request
     */
    protected async configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments
    ): Promise<void> {
        logger.info('Configuration done request received');
        logger.info('Initialization status:', {
            isInitialized: this.isInitialized,
            hasGdbChannel: !!this.gdbChannel,
            hasSshClient: !!this.sshClient
        });

        // Wait for initialization to complete if not already done
        if (!this.isInitialized) {
            logger.warn('Configuration done called before initialization complete, waiting...');
            // Wait up to 5 seconds for initialization
            const maxWait = 5000;
            const startTime = Date.now();
            while (!this.isInitialized && (Date.now() - startTime) < maxWait) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (!this.isInitialized) {
                const error = new Error('Initialization timeout: GDB session not ready');
                logger.error('Initialization timeout', error);
                this.sendErrorResponse(response, {
                    id: 3,
                    format: error.message
                });
                return;
            }
            logger.info('Initialization completed, continuing with configuration done');
        }

        try {
            // Apply pending breakpoints before running
            if (this.pendingBreakpoints.size > 0) {
                logger.info('Applying pending breakpoints', {
                    count: this.pendingBreakpoints.size
                });

                for (const [path, bps] of this.pendingBreakpoints.entries()) {
                    const remotePath = this.pathMapper?.toRemotePath(path) || path;
                    for (const bp of bps) {
                        try {
                            logger.info('Applying pending breakpoint', {
                                path: remotePath,
                                line: bp.line
                            });
                            const record = await this.sendGDBCommand(`break-insert ${remotePath}:${bp.line}`);
                            const gdbId = this.getGdbBreakpointId(record);
                            if (gdbId !== undefined) {
                                this.rememberGdbBreakpoint(path, bp.line, gdbId);
                            }
                            logger.info('Pending breakpoint applied successfully', { gdbId });
                        } catch (error) {
                            logger.error('Failed to apply pending breakpoint', { path, line: bp.line, error });
                        }
                    }
                }
                this.pendingBreakpoints.clear();
            }

            // Start execution if not a core dump and not attach mode
            if (this.configuration && !this.configuration.coreDumpPath && this.configuration.request === 'launch') {
                logger.info('Starting program execution', {
                    stopAtEntry: this.configuration.stopAtEntry,
                    hasGdbChannel: !!this.gdbChannel
                });

                if (this.configuration.stopAtEntry) {
                    await this.sendGDBCommand('exec-run --start');
                } else {
                    await this.sendGDBCommand('exec-run');
                }
            }

            this.sendResponse(response);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;
            logger.error('Configuration done failed', {
                message: errorMessage,
                stack: errorStack,
                error: error
            });
            this.sendErrorResponse(response, {
                id: 3,
                format: `Failed to start program: ${errorMessage}`
            });
        }
    }

    /**
     * Set breakpoints request
     */
    protected async setBreakpointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments
    ): Promise<void> {
        logger.info('=== setBreakpointsRequest called ===');
        logger.info('Breakpoint request details:', {
            sourcePath: args.source.path,
            sourceName: args.source.name,
            sourceReference: args.source.sourceReference,
            breakpointCount: args.breakpoints?.length || 0,
            breakpoints: args.breakpoints?.map(bp => ({
                line: bp.line,
                column: bp.column,
                condition: bp.condition,
                hitCondition: bp.hitCondition,
                logMessage: bp.logMessage
            }))
        });

        const path = args.source.path;
        if (!path) {
            logger.warn('Breakpoint request missing source path');
            response.body = { breakpoints: [] };
            this.sendResponse(response);
            return;
        }
        const remotePath = this.pathMapper?.toRemotePath(path) || path;

        logger.info('Path mapping:', {
            localPath: path,
            remotePath: remotePath,
            pathMapperExists: !!this.pathMapper
        });

        // If GDB isn't ready yet, queue the breakpoints
        if (!this.gdbChannel) {
            logger.info('GDB not ready yet, queueing breakpoints for later');
            if (args.breakpoints) {
                this.pendingBreakpoints.set(path, args.breakpoints);
            }
            // Return pending breakpoints as unverified
            const breakpoints: DebugProtocol.Breakpoint[] = [];
            if (args.breakpoints) {
                for (const bp of args.breakpoints) {
                    breakpoints.push(new Breakpoint(false, bp.line));
                }
            }
            response.body = { breakpoints };
            this.sendResponse(response);
            return;
        }

        // Clear existing breakpoints for this file
        const existingGdbBreakpoints = this.gdbBreakpoints.get(path);
        if (existingGdbBreakpoints) {
            for (const gdbId of existingGdbBreakpoints.values()) {
                await this.sendGDBCommand(`break-delete ${gdbId}`);
            }
            this.gdbBreakpoints.delete(path);
        }

        const breakpoints: DebugProtocol.Breakpoint[] = [];

        // Set new breakpoints
        if (args.breakpoints) {
            for (const sourceBp of args.breakpoints) {
                try {
                    logger.info('Setting breakpoint', {
                        line: sourceBp.line,
                        remotePath,
                        command: `break-insert ${remotePath}:${sourceBp.line}`
                    });
                    const record = await this.sendGDBCommand(`break-insert ${remotePath}:${sourceBp.line}`);
                    const gdbId = this.getGdbBreakpointId(record);
                    logger.info('Breakpoint set successfully', { line: sourceBp.line });
                    const breakpoint = new Breakpoint(true, sourceBp.line);
                    if (gdbId !== undefined) {
                        breakpoint.setId(gdbId);
                        this.rememberGdbBreakpoint(path, sourceBp.line, gdbId);
                    }
                    breakpoints.push(breakpoint);
                } catch (error) {
                    logger.error('Failed to set breakpoint', { line: sourceBp.line, error });
                    breakpoints.push(new Breakpoint(false, sourceBp.line));
                }
            }
        }

        this.breakpoints.set(path, breakpoints);
        response.body = { breakpoints };
        this.sendResponse(response);
    }

    /**
     * Threads request
     */
    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = {
            threads: [new Thread(this.currentThreadId, 'Main Thread')]
        };
        this.sendResponse(response);
    }

    /**
     * Stack trace request
     */
    protected async stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments
    ): Promise<void> {
        try {
            logger.info('Stack trace request', { threadId: args.threadId });

            // Reuse pending stack trace request if one is in progress
            if (!this.pendingStackTrace) {
                this.pendingStackTrace = this.sendGDBCommand('stack-list-frames');
                // Clear the pending request once it completes (success or failure)
                this.pendingStackTrace.finally(() => {
                    this.pendingStackTrace = null;
                });
            } else {
                logger.info('Reusing pending stack trace request');
            }

            const record = await this.pendingStackTrace;
            logger.info('Stack frames response received', {
                record,
                class: record.class,
                hasResults: !!record.results,
                resultsLength: record.results?.length
            });

            // Also fetch function arguments for all frames
            let frameArgs: Map<number, string> = new Map();
            try {
                const argsRecord = await this.sendGDBCommand('stack-list-arguments 1');
                frameArgs = this.parseStackArguments(argsRecord);
            } catch (error) {
                logger.warn('Failed to get stack arguments', { error });
            }

            const stackFrames: DebugProtocol.StackFrame[] = [];

            // Parse stack frames from the response
            const stackValue = this.gdbMI.findResult(record.results, 'stack');
            logger.info('Stack value found', { stackValue, type: typeof stackValue });

            const stackList = this.gdbMI.getList(stackValue);
            logger.info('Stack list parsed', {
                hasStackList: !!stackList,
                valuesLength: stackList?.values.length
            });

            if (stackList) {
                for (const frameValue of stackList.values) {
                    logger.info('Processing frame value', { frameValue });
                    let frameTuple = this.gdbMI.getTuple(frameValue);
                    logger.info('Frame tuple', { frameTuple });

                    if (frameTuple) {
                        // Check if this is a wrapper tuple with "frame" variable
                        // GDB returns: frame={level="0",...} wrapped in an extra tuple
                        const frameResult = this.gdbMI.findResult(frameTuple.results, 'frame');
                        if (frameResult) {
                            const innerTuple = this.gdbMI.getTuple(frameResult);
                            if (innerTuple) {
                                frameTuple = innerTuple;
                                logger.info('Extracted inner frame tuple', { frameTuple });
                            }
                        }

                        const frame = this.gdbMI.parseStackFrame(frameTuple);
                        logger.info('Parsed stack frame', { frame });

                        // Build function signature with arguments
                        const argsStr = frameArgs.get(frame.level);
                        const funcSignature = argsStr !== undefined
                            ? `${frame.func}(${argsStr})`
                            : frame.func;

                        // Convert to VSCode StackFrame
                        const source = frame.fullname || frame.file
                            ? new Source(
                                frame.file || 'unknown',
                                this.pathMapper?.toLocalPath(frame.fullname || frame.file!) || frame.fullname || frame.file
                            )
                            : undefined;

                        const stackFrame = new StackFrame(
                            frame.level,
                            funcSignature,
                            source,
                            frame.line || 0,
                            0
                        );

                        logger.info('Created VSCode stack frame', { stackFrame });
                        stackFrames.push(stackFrame);
                    }
                }
            } else {
                logger.warn('No stack list found in response');
            }

            logger.info('Returning stack frames', { count: stackFrames.length });
            response.body = {
                stackFrames,
                totalFrames: stackFrames.length
            };
            this.sendResponse(response);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;
            logger.error('Failed to get stack trace', {
                message: errorMessage,
                stack: errorStack,
                error: error
            });
            this.sendErrorResponse(response, {
                id: 4,
                format: `Failed to get stack trace: ${errorMessage}`
            });
        }
    }

    /**
     * Parse stack arguments from stack-list-arguments response
     * Returns a map of frame level -> formatted arguments string
     */
    private parseStackArguments(record: MIRecord): Map<number, string> {
        const result = new Map<number, string>();

        const stackArgsValue = this.gdbMI.findResult(record.results, 'stack-args');
        const stackArgsList = this.gdbMI.getList(stackArgsValue);

        if (!stackArgsList) {
            return result;
        }

        for (const frameValue of stackArgsList.values) {
            let frameTuple = this.gdbMI.getTuple(frameValue);
            if (!frameTuple) {
                continue;
            }

            // Check for wrapper tuple with "frame" key
            const frameResult = this.gdbMI.findResult(frameTuple.results, 'frame');
            if (frameResult) {
                const innerTuple = this.gdbMI.getTuple(frameResult);
                if (innerTuple) {
                    frameTuple = innerTuple;
                }
            }

            const levelStr = this.gdbMI.getStringValue(this.gdbMI.findResult(frameTuple.results, 'level'));
            const level = levelStr ? parseInt(levelStr, 10) : -1;

            if (level < 0) {
                continue;
            }

            const argsValue = this.gdbMI.findResult(frameTuple.results, 'args');
            const argsList = this.gdbMI.getList(argsValue);

            if (!argsList) {
                result.set(level, '');
                continue;
            }

            const argStrings: string[] = [];
            for (const argValue of argsList.values) {
                const argTuple = this.gdbMI.getTuple(argValue);
                if (argTuple) {
                    const name = this.gdbMI.getStringValue(this.gdbMI.findResult(argTuple.results, 'name'));
                    const value = this.gdbMI.getStringValue(this.gdbMI.findResult(argTuple.results, 'value'));
                    if (name && value !== undefined) {
                        argStrings.push(`${name}=${value}`);
                    } else if (name) {
                        argStrings.push(name);
                    }
                }
            }

            result.set(level, argStrings.join(', '));
        }

        return result;
    }

    /**
     * Scopes request
     */
    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        logger.info('Scopes request', { frameId: args.frameId });

        const scopes: Scope[] = [
            new Scope('Local', this.variableHandles.create(`local_${args.frameId}`), false)
        ];

        response.body = { scopes };
        this.sendResponse(response);
    }

    /**
     * Variables request
     */
    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments
    ): Promise<void> {
        try {
            logger.info('Variables request', { variablesReference: args.variablesReference });

            const handle = this.variableHandles.get(args.variablesReference);
            logger.info('Variable handle', { handle });

            if (!handle || !handle.startsWith('local_')) {
                response.body = { variables: [] };
                this.sendResponse(response);
                return;
            }

            // Get local variables using stack-list-variables
            const record = await this.sendGDBCommand('stack-list-variables --simple-values');
            logger.info('Variables response received', { record });

            const variables: DebugProtocol.Variable[] = [];

            // Parse variables from response
            const variablesList = this.gdbMI.getList(this.gdbMI.findResult(record.results, 'variables'));
            logger.info('Variables list', { variablesList });

            if (variablesList) {
                for (const varValue of variablesList.values) {
                    const varTuple = this.gdbMI.getTuple(varValue);
                    if (varTuple) {
                        const name = this.gdbMI.getStringValue(this.gdbMI.findResult(varTuple.results, 'name'));
                        const value = this.gdbMI.getStringValue(this.gdbMI.findResult(varTuple.results, 'value'));
                        const type = this.gdbMI.getStringValue(this.gdbMI.findResult(varTuple.results, 'type'));

                        if (name) {
                            logger.info('Parsed variable', { name, value, type });
                            variables.push({
                                name: name,
                                value: value || '<unknown>',
                                type: type,
                                variablesReference: 0
                            });
                        }
                    }
                }
            }

            logger.info('Returning variables', { count: variables.length, variables });
            response.body = { variables };
            this.sendResponse(response);
        } catch (error) {
            logger.error('Failed to get variables', error);
            response.body = { variables: [] };
            this.sendResponse(response);
        }
    }

    /**
     * Continue request
     */
    protected async continueRequest(
        response: DebugProtocol.ContinueResponse,
        args: DebugProtocol.ContinueArguments
    ): Promise<void> {
        try {
            await this.sendGDBCommand('exec-continue');
            this.isRunning = true;
            response.body = { allThreadsContinued: true };
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, {
                id: 5,
                format: `Failed to continue: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    /**
     * Next (step over) request
     */
    protected async nextRequest(
        response: DebugProtocol.NextResponse,
        args: DebugProtocol.NextArguments
    ): Promise<void> {
        try {
            await this.sendGDBCommand('exec-next');
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, {
                id: 6,
                format: `Failed to step over: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    /**
     * Step in request
     */
    protected async stepInRequest(
        response: DebugProtocol.StepInResponse,
        args: DebugProtocol.StepInArguments
    ): Promise<void> {
        try {
            await this.sendGDBCommand('exec-step');
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, {
                id: 7,
                format: `Failed to step in: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    /**
     * Step out request
     */
    protected async stepOutRequest(
        response: DebugProtocol.StepOutResponse,
        args: DebugProtocol.StepOutArguments
    ): Promise<void> {
        try {
            await this.sendGDBCommand('exec-finish');
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, {
                id: 8,
                format: `Failed to step out: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    /**
     * Pause request
     */
    protected async pauseRequest(
        response: DebugProtocol.PauseResponse,
        args: DebugProtocol.PauseArguments
    ): Promise<void> {
        try {
            await this.sendGDBCommand('exec-interrupt');
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, {
                id: 9,
                format: `Failed to pause: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    /**
     * Evaluate request
     */
    protected async evaluateRequest(
        response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments
    ): Promise<void> {
        try {
            const record = await this.sendGDBCommand(`data-evaluate-expression ${args.expression}`);
            const value = this.gdbMI.getStringValue(this.gdbMI.findResult(record.results, 'value'));

            // Get type using var-create which returns type information
            // Note: GDB var names must start with a letter, not underscore
            let type: string | undefined;
            try {
                const varName = `eval${Date.now()}`;
                const createRecord = await this.sendGDBCommand(`var-create ${varName} * ${args.expression}`);
                type = this.gdbMI.getStringValue(this.gdbMI.findResult(createRecord.results, 'type'));
                // Clean up the variable object
                await this.sendGDBCommand(`var-delete ${varName}`);
            } catch {
                // Ignore type fetch errors
            }

            response.body = {
                result: value || '<unable to evaluate>',
                type: type,
                variablesReference: 0
            };
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, {
                id: 10,
                format: `Failed to evaluate: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    /**
     * Disconnect request
     */
    protected async disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
        args: DebugProtocol.DisconnectArguments
    ): Promise<void> {
        logger.info('Disconnect request received');

        try {
            // Kill the remote process
            if (this.gdbChannel) {
                await this.sendGDBCommand('gdb-exit');
                this.gdbChannel.end();
                this.gdbChannel = null;
            }

            // Disconnect SSH
            if (this.configuration) {
                const sshDetails = this.configParser.getConnectionDetails(this.configuration.sshHost);
                this.sshManager.disconnect(sshDetails);
            }

            this.sendResponse(response);
        } catch (error) {
            logger.error('Disconnect failed', error);
            this.sendResponse(response);
        }
    }

    /**
     * Terminate request
     */
    protected terminateRequest(
        response: DebugProtocol.TerminateResponse,
        args: DebugProtocol.TerminateArguments
    ): void {
        this.disconnectRequest(response, {});
    }
}
