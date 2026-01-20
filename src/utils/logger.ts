import * as vscode from 'vscode';

/**
 * Logger for Remote GDB extension
 */
export class Logger {
    private outputChannel: vscode.OutputChannel;
    private gdbMIChannel: vscode.OutputChannel;
    private verbose: boolean = false;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Remote GDB');
        this.gdbMIChannel = vscode.window.createOutputChannel('Remote GDB (GDB/MI)');
    }

    setVerbose(verbose: boolean): void {
        this.verbose = verbose;
    }

    error(message: string, ...args: any[]): void {
        const formatted = this.format('ERROR', message, args);
        this.outputChannel.appendLine(formatted);
        console.error(formatted);
    }

    warn(message: string, ...args: any[]): void {
        const formatted = this.format('WARN', message, args);
        this.outputChannel.appendLine(formatted);
        console.warn(formatted);
    }

    info(message: string, ...args: any[]): void {
        const formatted = this.format('INFO', message, args);
        this.outputChannel.appendLine(formatted);
        console.log(formatted);
    }

    debug(message: string, ...args: any[]): void {
        if (this.verbose) {
            const formatted = this.format('DEBUG', message, args);
            this.outputChannel.appendLine(formatted);
            console.log(formatted);
        }
    }

    gdbCommand(command: string): void {
        if (this.verbose) {
            this.gdbMIChannel.appendLine(`>> ${command}`);
        }
    }

    gdbResponse(response: string): void {
        if (this.verbose) {
            this.gdbMIChannel.appendLine(`<< ${response}`);
        }
    }

    show(): void {
        this.outputChannel.show();
    }

    showGDBMI(): void {
        this.gdbMIChannel.show();
    }

    dispose(): void {
        this.outputChannel.dispose();
        this.gdbMIChannel.dispose();
    }

    private format(level: string, message: string, args: any[]): string {
        const timestamp = new Date().toISOString();
        const formattedArgs = args.length > 0 ? ' ' + JSON.stringify(args) : '';
        return `[${timestamp}] [${level}] ${message}${formattedArgs}`;
    }
}

// Global logger instance
export const logger = new Logger();
