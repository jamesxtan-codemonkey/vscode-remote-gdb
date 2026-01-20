import { Client, ClientChannel } from 'ssh2';
import * as fs from 'fs';
import { SSHConnectionDetails } from './types/config';
import { SSHSession, SSHSessionState } from './types/ssh';
import { logger } from './utils/logger';
import { EventEmitter } from 'events';

/**
 * Manages SSH connections to remote machines
 */
export class SSHManager extends EventEmitter {
    private sessions: Map<string, SSHSession> = new Map();
    private reconnectAttempts: Map<string, number> = new Map();
    private maxReconnectAttempts = 3;
    private reconnectDelay = 2000; // ms

    /**
     * Connect to remote host via SSH
     */
    async connect(details: SSHConnectionDetails, timeout: number = 10000): Promise<Client> {
        const sessionKey = this.getSessionKey(details);

        // Check if already connected
        const existing = this.sessions.get(sessionKey);
        if (existing && existing.state === SSHSessionState.Connected) {
            logger.debug('Reusing existing SSH connection', { host: details.host });
            return existing.client;
        }

        logger.info('Connecting to SSH host', {
            hostname: details.hostname,
            port: details.port,
            username: details.username
        });

        const client = new Client();

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                client.end();
                reject(new Error(`SSH connection timeout after ${timeout}ms`));
            }, timeout);

            client.on('ready', () => {
                clearTimeout(timer);
                logger.info('SSH connection established', { host: details.host });

                this.sessions.set(sessionKey, {
                    client,
                    state: SSHSessionState.Connected,
                    host: details.host,
                    lastActivity: Date.now()
                });

                this.reconnectAttempts.set(sessionKey, 0);
                this.setupConnectionMonitoring(sessionKey, details);

                resolve(client);
            });

            client.on('error', (err) => {
                clearTimeout(timer);
                logger.error('SSH connection error', {
                    message: err.message,
                    stack: err.stack,
                    error: err
                });
                this.updateSessionState(sessionKey, SSHSessionState.Failed);
                reject(err);
            });

            client.on('close', () => {
                logger.info('SSH connection closed', { host: details.host });
                this.handleDisconnect(sessionKey, details);
            });

            // Load private key
            let privateKey: Buffer | undefined;
            if (details.privateKeyPath && fs.existsSync(details.privateKeyPath)) {
                privateKey = fs.readFileSync(details.privateKeyPath);
            } else {
                clearTimeout(timer);
                reject(new Error('SSH private key not found'));
                return;
            }

            // Connect with keepalive to prevent timeout during debugging
            client.connect({
                host: details.hostname,
                port: details.port,
                username: details.username,
                privateKey,
                keepaliveInterval: 1000, // Send keepalive every 1 second (aggressive to prevent timeout)
                keepaliveCountMax: 10,   // Allow 10 missed keepalives before disconnect
                readyTimeout: 30000      // Longer ready timeout
            });
        });
    }

    /**
     * Execute a command on remote host
     */
    async execCommand(client: Client, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        return new Promise((resolve, reject) => {
            client.exec(command, (err, stream) => {
                if (err) {
                    reject(err);
                    return;
                }

                let stdout = '';
                let stderr = '';

                stream.on('data', (data: Buffer) => {
                    stdout += data.toString();
                });

                stream.stderr.on('data', (data: Buffer) => {
                    stderr += data.toString();
                });

                stream.on('close', (exitCode: number) => {
                    resolve({ stdout, stderr, exitCode });
                });
            });
        });
    }

    /**
     * Spawn a process (like GDB) and return the channel
     */
    async spawnProcess(client: Client, command: string): Promise<ClientChannel> {
        logger.info('Spawning remote process', { command });
        return new Promise((resolve, reject) => {
            client.exec(command, (err, stream) => {
                if (err) {
                    logger.error('Failed to exec command', { command, error: err });
                    reject(err);
                    return;
                }
                logger.info('Remote process spawned successfully');
                resolve(stream);
            });
        });
    }

    /**
     * Disconnect from remote host
     */
    disconnect(details: SSHConnectionDetails): void {
        const sessionKey = this.getSessionKey(details);
        const session = this.sessions.get(sessionKey);

        if (session) {
            logger.info('Disconnecting SSH connection', { host: details.host });
            session.client.end();
            this.sessions.delete(sessionKey);
            this.reconnectAttempts.delete(sessionKey);
        }
    }

    /**
     * Get session state
     */
    getSessionState(details: SSHConnectionDetails): SSHSessionState {
        const sessionKey = this.getSessionKey(details);
        const session = this.sessions.get(sessionKey);
        return session ? session.state : SSHSessionState.Disconnected;
    }

    /**
     * Disconnect all sessions
     */
    disconnectAll(): void {
        for (const session of this.sessions.values()) {
            session.client.end();
        }
        this.sessions.clear();
        this.reconnectAttempts.clear();
    }

    /**
     * Handle connection disconnect
     */
    private handleDisconnect(sessionKey: string, details: SSHConnectionDetails): void {
        const session = this.sessions.get(sessionKey);
        if (!session) {
            return;
        }

        this.updateSessionState(sessionKey, SSHSessionState.Disconnected);
        this.emit('disconnected', details.host);

        // Attempt reconnection
        const attempts = this.reconnectAttempts.get(sessionKey) || 0;
        if (attempts < this.maxReconnectAttempts) {
            this.attemptReconnect(sessionKey, details, attempts);
        } else {
            logger.error('Max reconnect attempts reached', { host: details.host });
            this.emit('reconnectFailed', details.host);
        }
    }

    /**
     * Attempt to reconnect
     */
    private async attemptReconnect(sessionKey: string, details: SSHConnectionDetails, attempt: number): Promise<void> {
        this.updateSessionState(sessionKey, SSHSessionState.Reconnecting);
        this.reconnectAttempts.set(sessionKey, attempt + 1);

        logger.info('Attempting to reconnect', {
            host: details.host,
            attempt: attempt + 1,
            maxAttempts: this.maxReconnectAttempts
        });

        await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));

        try {
            await this.connect(details);
            this.emit('reconnected', details.host);
        } catch (error) {
            logger.error('Reconnect attempt failed', { host: details.host, error });
        }
    }

    /**
     * Setup connection monitoring
     */
    private setupConnectionMonitoring(sessionKey: string, details: SSHConnectionDetails): void {
        const session = this.sessions.get(sessionKey);
        if (!session) {
            return;
        }

        // Monitor for keepalive
        const interval = setInterval(() => {
            const currentSession = this.sessions.get(sessionKey);
            if (!currentSession || currentSession.state !== SSHSessionState.Connected) {
                clearInterval(interval);
                return;
            }

            // Send keepalive (exec a simple command)
            this.execCommand(currentSession.client, 'echo keepalive')
                .then(() => {
                    currentSession.lastActivity = Date.now();
                })
                .catch((err) => {
                    logger.warn('Keepalive failed', { host: details.host, error: err });
                });
        }, 30000); // Every 30 seconds
    }

    /**
     * Update session state
     */
    private updateSessionState(sessionKey: string, state: SSHSessionState): void {
        const session = this.sessions.get(sessionKey);
        if (session) {
            session.state = state;
        }
    }

    /**
     * Generate unique session key
     */
    private getSessionKey(details: SSHConnectionDetails): string {
        return `${details.username}@${details.hostname}:${details.port}`;
    }
}
