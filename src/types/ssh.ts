import { Client } from 'ssh2';

/**
 * SSH Session State
 */
export enum SSHSessionState {
    Disconnected = 'disconnected',
    Connecting = 'connecting',
    Connected = 'connected',
    Reconnecting = 'reconnecting',
    Failed = 'failed'
}

/**
 * SSH Session
 */
export interface SSHSession {
    client: Client;
    state: SSHSessionState;
    host: string;
    lastActivity: number;
}
