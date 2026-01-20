/**
 * GDB/MI Output Record Types
 */
export type MIRecordType = 'result' | 'exec' | 'status' | 'notify' | 'console' | 'target' | 'log';

/**
 * GDB/MI Result Class
 */
export type MIResultClass = 'done' | 'running' | 'connected' | 'error' | 'exit';

/**
 * GDB/MI Async Class
 */
export type MIAsyncClass = 'stopped' | 'running' | 'thread-created' | 'thread-exited' | 'breakpoint-modified';

/**
 * GDB/MI Output Record
 */
export interface MIRecord {
    type: MIRecordType;
    token?: number;
    class?: MIResultClass | MIAsyncClass;
    results?: MIResult[];
    output?: string;
}

/**
 * GDB/MI Result (key-value pair)
 */
export interface MIResult {
    variable: string;
    value: MIValue;
}

/**
 * GDB/MI Value Types
 */
export type MIValue = string | MITuple | MIList;

export interface MITuple {
    type: 'tuple';
    results: MIResult[];
}

export interface MIList {
    type: 'list';
    values: MIValue[];
}

/**
 * Breakpoint information
 */
export interface GDBBreakpoint {
    id: number;
    verified: boolean;
    line?: number;
    source?: string;
}

/**
 * Stack frame information
 */
export interface GDBStackFrame {
    level: number;
    addr: string;
    func: string;
    file?: string;
    fullname?: string;
    line?: number;
}

/**
 * Variable information
 */
export interface GDBVariable {
    name: string;
    value: string;
    type?: string;
    numchild?: number;
    exp?: string;
}

/**
 * Thread information
 */
export interface GDBThread {
    id: number;
    targetId: string;
    name?: string;
    state: string;
}

/**
 * Stop reason
 */
export type StopReason =
    | 'breakpoint-hit'
    | 'end-stepping-range'
    | 'signal-received'
    | 'exited-normally'
    | 'exited'
    | 'exited-signalled';

/**
 * Stopped event information
 */
export interface GDBStoppedEvent {
    reason: StopReason;
    threadId?: number;
    breakpointId?: number;
    signal?: string;
    exitCode?: number;
    frame?: GDBStackFrame;
}
