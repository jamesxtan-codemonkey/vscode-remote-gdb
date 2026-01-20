/**
 * Remote GDB Debug Configuration
 */
export interface RemoteGDBConfiguration {
    // Required
    type: 'remote-gdb';
    request: 'launch' | 'attach';
    name: string;
    sshHost: string;
    program: string;

    // SSH connection (optional, overrides .ssh/config)
    sshHostname?: string;
    sshPort?: number;
    sshUsername?: string;
    sshKeyFile?: string;

    // Launch/Attach specific
    args?: string[];
    cwd?: string;
    env?: { [key: string]: string };
    processId?: string | number;
    coreDumpPath?: string;

    // GDB settings
    gdbPath?: string;
    stopAtEntry?: boolean;
    setupCommands?: string[];

    // Path mapping
    sourceMap?: { [localPath: string]: string };

    // Advanced
    verbose?: boolean;
    timeout?: number;
}

/**
 * SSH Connection Details
 */
export interface SSHConnectionDetails {
    host: string;
    hostname: string;
    port: number;
    username: string;
    privateKeyPath?: string;
}
