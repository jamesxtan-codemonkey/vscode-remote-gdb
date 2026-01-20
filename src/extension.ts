import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { RemoteGDBDebugSession } from './debugAdapter';
import { logger } from './utils/logger';
import { ConfigParser } from './configParser';
import { SSHManager } from './sshManager';

export function activate(context: vscode.ExtensionContext) {
    logger.info('Remote GDB extension activated');

    // Register debug configuration provider
    const provider = new RemoteGDBConfigurationProvider();
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('remote-gdb', provider)
    );

    // Register debug adapter descriptor factory
    const factory = new RemoteGDBDebugAdapterDescriptorFactory();
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('remote-gdb', factory)
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('remote-gdb.createConfig', async () => {
            await createDebugConfiguration();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('remote-gdb.pickRemoteProcess', async () => {
            return await pickRemoteProcess();
        })
    );

    // Update verbose logging when configuration changes
    vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('remote-gdb.logging.verbose')) {
            const config = vscode.workspace.getConfiguration('remote-gdb');
            const verbose = config.get<boolean>('logging.verbose', false);
            logger.setVerbose(verbose);
        }
    });

    // Set initial verbose logging
    const config = vscode.workspace.getConfiguration('remote-gdb');
    const verbose = config.get<boolean>('logging.verbose', false);
    logger.setVerbose(verbose);

    // Add status bar item
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(debug-alt) Remote GDB';
    statusBarItem.tooltip = 'Remote GDB Debugger';
    statusBarItem.command = 'remote-gdb.createConfig';
    context.subscriptions.push(statusBarItem);

    // Show status bar item when debugging
    vscode.debug.onDidStartDebugSession((session) => {
        if (session.type === 'remote-gdb') {
            statusBarItem.show();
        }
    });

    vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.type === 'remote-gdb') {
            statusBarItem.hide();
        }
    });
}

export function deactivate() {
    logger.info('Remote GDB extension deactivated');
    logger.dispose();
}

/**
 * Debug configuration provider
 */
class RemoteGDBConfigurationProvider implements vscode.DebugConfigurationProvider {
    /**
     * Resolve debug configuration before launch
     */
    resolveDebugConfiguration(
        folder: WorkspaceFolder | undefined,
        config: DebugConfiguration,
        token?: CancellationToken
    ): ProviderResult<DebugConfiguration> {
        logger.info('Resolving debug configuration:', config);

        // If launch.json is missing or empty
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && (editor.document.languageId === 'c' || editor.document.languageId === 'cpp')) {
                config.type = 'remote-gdb';
                config.name = 'Remote GDB Launch';
                config.request = 'launch';
                config.sshHost = 'your-remote-host';
                config.program = '/path/to/remote/executable';
                config.sourceMap = {
                    '${workspaceFolder}': '/remote/source/path'
                };
            }
        }

        if (!config.sshHost) {
            logger.error('Cannot find SSH host to debug. Config:', config);
            return vscode.window.showInformationMessage('Cannot find SSH host to debug').then(_ => {
                return undefined;
            });
        }

        if (!config.program) {
            logger.error('Cannot find a program to debug. Config:', config);
            return vscode.window.showInformationMessage('Cannot find a program to debug').then(_ => {
                return undefined;
            });
        }

        return config;
    }
}

/**
 * Debug adapter descriptor factory
 */
class RemoteGDBDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): ProviderResult<vscode.DebugAdapterDescriptor> {
        // Use inline debug adapter
        return new vscode.DebugAdapterInlineImplementation(new RemoteGDBDebugSession());
    }
}

/**
 * Create debug configuration wizard
 */
async function createDebugConfiguration(): Promise<void> {
    const configParser = new ConfigParser();
    const availableHosts = configParser.getAvailableHosts();

    let sshHost: string | undefined;
    if (availableHosts.length > 0) {
        sshHost = await vscode.window.showQuickPick(availableHosts, {
            placeHolder: 'Select SSH host from ~/.ssh/config',
            ignoreFocusOut: true
        });
    } else {
        sshHost = await vscode.window.showInputBox({
            prompt: 'Enter SSH host',
            placeHolder: 'user@hostname',
            ignoreFocusOut: true
        });
    }

    if (!sshHost) {
        return;
    }

    const program = await vscode.window.showInputBox({
        prompt: 'Enter remote executable path',
        placeHolder: '/path/to/remote/executable',
        ignoreFocusOut: true
    });

    if (!program) {
        return;
    }

    const remotePath = await vscode.window.showInputBox({
        prompt: 'Enter remote source path',
        placeHolder: '/remote/source/path',
        ignoreFocusOut: true
    });

    if (!remotePath) {
        return;
    }

    const debugType = await vscode.window.showQuickPick(
        ['Launch', 'Attach', 'Core Dump'],
        {
            placeHolder: 'Select debug mode',
            ignoreFocusOut: true
        }
    );

    if (!debugType) {
        return;
    }

    let config: any = {
        type: 'remote-gdb',
        request: debugType.toLowerCase() === 'attach' ? 'attach' : 'launch',
        name: `Remote GDB ${debugType}`,
        sshHost,
        program,
        sourceMap: {
            '${workspaceFolder}': remotePath
        }
    };

    if (debugType.toLowerCase() === 'attach') {
        config.processId = '${command:remote-gdb.pickRemoteProcess}';
    } else if (debugType.toLowerCase() === 'core dump') {
        const coreDumpPath = await vscode.window.showInputBox({
            prompt: 'Enter core dump path',
            placeHolder: '/path/to/core',
            ignoreFocusOut: true
        });
        if (coreDumpPath) {
            config.coreDumpPath = coreDumpPath;
        }
    }

    // Add to launch.json
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const launchJsonUri = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'launch.json');

    try {
        let launchJson: any = { version: '0.2.0', configurations: [] };

        try {
            const content = await vscode.workspace.fs.readFile(launchJsonUri);
            launchJson = JSON.parse(content.toString());
        } catch {
            // File doesn't exist, use default
        }

        launchJson.configurations.push(config);

        const content = JSON.stringify(launchJson, null, 2);
        await vscode.workspace.fs.writeFile(launchJsonUri, Buffer.from(content, 'utf-8'));

        vscode.window.showInformationMessage('Debug configuration added to launch.json');

        // Open launch.json
        const doc = await vscode.workspace.openTextDocument(launchJsonUri);
        await vscode.window.showTextDocument(doc);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to create configuration: ${error}`);
    }
}

/**
 * Pick remote process to attach to
 */
async function pickRemoteProcess(): Promise<string | undefined> {
    // Get current debug configuration
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== 'remote-gdb') {
        vscode.window.showErrorMessage('No active Remote GDB debug session');
        return undefined;
    }

    const config = session.configuration;
    const configParser = new ConfigParser();
    const sshManager = new SSHManager();

    try {
        const sshDetails = configParser.getConnectionDetails(config.sshHost, {
            hostname: config.sshHostname,
            port: config.sshPort,
            username: config.sshUsername,
            privateKeyPath: config.sshKeyFile
        });

        const client = await sshManager.connect(sshDetails);

        // List processes
        const result = await sshManager.execCommand(client, 'ps aux');
        const lines = result.stdout.split('\n');

        const processes = lines.slice(1).map(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 11) {
                const pid = parts[1];
                const cmd = parts.slice(10).join(' ');
                return { pid, cmd, label: `${pid}: ${cmd}` };
            }
            return null;
        }).filter(p => p !== null);

        const selected = await vscode.window.showQuickPick(
            processes.map(p => p!.label),
            {
                placeHolder: 'Select process to attach to',
                ignoreFocusOut: true
            }
        );

        if (selected) {
            const pid = selected.split(':')[0];
            return pid;
        }

        return undefined;
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to list processes: ${error}`);
        return undefined;
    }
}
