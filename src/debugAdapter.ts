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
import { MIRecord } from './types/gdb';

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
    private gdbBreakpoints: Map<number, number> = new Map(); // VSCode line -> GDB breakpoint ID
    private currentThreadId = 1;
    private outputBuffer = '';
    private isRunning = false;

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
     * Initialize request
     */
    protected initializeRequest(
        response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments
    ): void {
        logger.info('Initialize request received');

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
        this.sendEvent(new InitializedEvent());
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

            this.sshClient = await this.sshManager.connect(sshDetails, remoteArgs.timeout || 10000);

            // Start GDB
            await this.startGDB(remoteArgs);

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

        this.gdbChannel = await this.sshManager.spawnProcess(this.sshClient, gdbCommand);

        // Setup GDB output handlers
        this.gdbChannel.on('data', (data: Buffer) => {
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

        // Wait for GDB to be ready
        await this.waitForGDBPrompt();

        // Execute setup commands
        if (config.setupCommands && config.setupCommands.length > 0) {
            for (const cmd of config.setupCommands) {
                await this.sendGDBCommand(cmd);
            }
        }

        // Set working directory if specified
        if (config.cwd && !config.coreDumpPath) {
            await this.sendGDBCommand(`environment PWD ${config.cwd}`);
        }

        // Set environment variables
        if (config.env && !config.coreDumpPath) {
            for (const [key, value] of Object.entries(config.env)) {
                await this.sendGDBCommand(`environment ${key}=${value}`);
            }
        }

        // Set arguments
        if (config.args && config.args.length > 0 && !config.coreDumpPath) {
            const argsStr = config.args.join(' ');
            await this.sendGDBCommand(`exec-arguments ${argsStr}`);
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
        return new Promise((resolve) => {
            const checkPrompt = () => {
                if (this.outputBuffer.includes('(gdb)')) {
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
        this.outputBuffer += data;
        logger.gdbResponse(data);

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
    private async sendGDBCommand(command: string): Promise<void> {
        if (!this.gdbChannel) {
            throw new Error('GDB channel not available');
        }

        const cmd = this.gdbMI.command(command.split(' ')[0], command.split(' ').slice(1).join(' '));
        logger.gdbCommand(cmd);
        this.gdbChannel.stdin.write(cmd + '\n');
    }

    /**
     * Configuration done request
     */
    protected async configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments
    ): Promise<void> {
        logger.info('Configuration done');

        try {
            // Start execution if not a core dump and not attach mode
            if (this.configuration && !this.configuration.coreDumpPath && this.configuration.request === 'launch') {
                if (this.configuration.stopAtEntry) {
                    await this.sendGDBCommand('exec-run --start');
                } else {
                    await this.sendGDBCommand('exec-run');
                }
            }

            this.sendResponse(response);
        } catch (error) {
            logger.error('Configuration done failed', error);
            this.sendErrorResponse(response, {
                id: 3,
                format: `Failed to start program: ${error instanceof Error ? error.message : String(error)}`
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
        const path = args.source.path!;
        const remotePath = this.pathMapper?.toRemotePath(path) || path;

        logger.info('Setting breakpoints', { path, remotePath, lines: args.breakpoints?.map(bp => bp.line) });

        // Clear existing breakpoints for this file
        const existingBps = this.breakpoints.get(path) || [];
        for (const bp of existingBps) {
            if (bp.id) {
                await this.sendGDBCommand(`break-delete ${bp.id}`);
                this.gdbBreakpoints.delete(bp.line!);
            }
        }

        const breakpoints: DebugProtocol.Breakpoint[] = [];

        // Set new breakpoints
        if (args.breakpoints) {
            for (const sourceBp of args.breakpoints) {
                try {
                    await this.sendGDBCommand(`break-insert ${remotePath}:${sourceBp.line}`);
                    // In a real implementation, we'd parse the response to get the GDB breakpoint ID
                    // For now, we'll assume it succeeded
                    breakpoints.push(new Breakpoint(true, sourceBp.line));
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
            await this.sendGDBCommand('stack-list-frames');
            // In a real implementation, we'd parse the response
            // For now, return empty stack
            response.body = { stackFrames: [], totalFrames: 0 };
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, {
                id: 4,
                format: `Failed to get stack trace: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    /**
     * Scopes request
     */
    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        const scopes: Scope[] = [
            new Scope('Local', this.variableHandles.create('local'), false),
            new Scope('Global', this.variableHandles.create('global'), true)
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
        // In a real implementation, we'd fetch variables from GDB
        response.body = { variables: [] };
        this.sendResponse(response);
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
            await this.sendGDBCommand(`data-evaluate-expression ${args.expression}`);
            // In a real implementation, we'd parse the response
            response.body = { result: 'N/A', variablesReference: 0 };
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
