# Remote GDB Debugger for VSCode

Debug C/C++ applications on remote Linux machines via SSH using GDB, directly from your Mac.

## Features

- **Remote Debugging**: Debug applications running on remote Linux machines from VSCode on Mac OSX
- **SSH Key Authentication**: Secure connection using SSH keys from `~/.ssh/config`
- **Multiple Debug Modes**:
  - **Launch**: Start a new process under GDB control
  - **Attach**: Attach to an already-running process by PID
  - **Core Dump**: Analyze core dump files
- **Full VSCode Integration**: Use native VSCode debug UI (breakpoints, variables, call stack, watch, etc.)
- **Path Mapping**: Automatically map local source paths to remote paths
- **Multi-Session Support**: Debug multiple applications on different remote machines simultaneously
- **Graceful Connection Handling**: Preserve debug state even if SSH connection drops temporarily
- **Configuration Wizard**: Easy setup with guided configuration wizard

## Requirements

### Local Machine (Mac OSX)
- VSCode 1.85.0 or higher
- SSH key-based authentication configured in `~/.ssh/config`

### Remote Machine (Linux)
- GDB 7.0 or higher installed
- SSH server running with key-based authentication enabled
- C/C++ application compiled with debug symbols (`-g` flag)

## Quick Start

### 1. Configure SSH

Ensure you have SSH key-based authentication set up in `~/.ssh/config`:

```
Host myserver
    HostName 192.168.1.100
    User username
    Port 22
    IdentityFile ~/.ssh/id_rsa
```

Test your connection:
```bash
ssh myserver
```

### 2. Create Debug Configuration

You can create a debug configuration in two ways:

**Option A: Using the Configuration Wizard**
1. Press `Cmd+Shift+P` and run **Remote GDB: Create Debug Configuration**
2. Follow the prompts to select SSH host, program path, etc.
3. The wizard will create a `launch.json` file automatically

**Option B: Manually Edit launch.json**
1. Open `.vscode/launch.json` in your workspace
2. Add a new configuration:

```json
{
    "type": "remote-gdb",
    "request": "launch",
    "name": "Remote GDB Launch",
    "sshHost": "myserver",
    "program": "/home/user/myapp",
    "args": [],
    "cwd": "/home/user",
    "sourceMap": {
        "${workspaceFolder}": "/home/user/myapp"
    }
}
```

### 3. Start Debugging

1. Set breakpoints in your source code by clicking the gutter
2. Press `F5` or **Run → Start Debugging**
3. Select **Remote GDB** from the debugger dropdown
4. Your application will start on the remote machine and stop at breakpoints

## Build and Package

Install dependencies:
```bash
npm install
```

Build the extension bundle:
```bash
npm run bundle
```

Create a production bundle:
```bash
npm run bundle:prod
```

Package a VSIX for distribution (outputs `remote-gdb-<version>.vsix` in the repo root):
```bash
npm run package
```

## Configuration Options

### Launch Mode

```json
{
    "type": "remote-gdb",
    "request": "launch",
    "name": "Remote GDB Launch",
    "sshHost": "myserver",           // SSH host from ~/.ssh/config
    "program": "/path/to/exe",        // Remote executable path
    "args": ["--verbose"],            // Command line arguments
    "cwd": "/working/dir",            // Working directory
    "env": {                          // Environment variables
        "DEBUG": "1"
    },
    "gdbPath": "/usr/bin/gdb",       // Path to GDB (optional)
    "stopAtEntry": false,             // Stop at main() (optional)
    "setupCommands": [                // GDB init commands (optional)
        "set print pretty on"
    ],
    "sourceMap": {                    // Path mapping (required)
        "${workspaceFolder}": "/remote/path"
    },
    "verbose": false                  // Enable verbose logging (optional)
}
```

### Attach Mode

```json
{
    "type": "remote-gdb",
    "request": "attach",
    "name": "Remote GDB Attach",
    "sshHost": "myserver",
    "program": "/path/to/exe",
    "processId": "${command:remote-gdb.pickRemoteProcess}",
    "sourceMap": {
        "${workspaceFolder}": "/remote/path"
    }
}
```

### Core Dump Analysis

```json
{
    "type": "remote-gdb",
    "request": "launch",
    "name": "Remote GDB Core Dump",
    "sshHost": "myserver",
    "program": "/path/to/exe",
    "coreDumpPath": "/path/to/core",
    "sourceMap": {
        "${workspaceFolder}": "/remote/path"
    }
}
```

## SSH Configuration Overrides

If you need to override SSH settings from `~/.ssh/config`:

```json
{
    "type": "remote-gdb",
    "request": "launch",
    "name": "Remote GDB",
    "sshHost": "myserver",
    "sshHostname": "192.168.1.100",   // Override hostname
    "sshPort": 2222,                   // Override port
    "sshUsername": "user",             // Override username
    "sshKeyFile": "/path/to/key",     // Override key file
    "program": "/path/to/exe"
}
```

## Features in Detail

### Breakpoints
- Click gutter to set/remove breakpoints
- Breakpoints sync automatically between VSCode and remote GDB
- Red dots indicate active breakpoints
- Gray dots indicate disabled breakpoints

### Variables
- View local variables, function parameters, and globals
- Expand structs, arrays, and pointers
- Hover over variables in code to see values
- Add watch expressions in the Watch panel

**Tip: Show Variable Types**

By default, VSCode hides variable types in the Variables and Watch panels. To enable it:
1. Open VSCode Settings (`Cmd+,`)
2. Search for `debug.showVariableTypes`
3. Check the box to enable it

### Call Stack
- View full call stack with function names and line numbers
- Click stack frames to navigate
- View local variables for each frame

### Debug Console
- Evaluate expressions interactively
- Execute GDB commands directly (e.g., `print myvar`)
- View program stdout/stderr

### Execution Control
- **Continue** (F5): Resume execution
- **Step Over** (F10): Execute next line
- **Step Into** (F11): Step into function calls
- **Step Out** (Shift+F11): Step out of current function
- **Pause**: Interrupt execution
- **Stop**: Terminate debug session

## Troubleshooting

### SSH Connection Failed
- Verify SSH key-based authentication works: `ssh myserver`
- Check that your key is added to SSH agent: `ssh-add -l`
- Verify `~/.ssh/config` has correct settings

### GDB Not Found
- Verify GDB is installed on remote: `ssh myserver "which gdb"`
- Specify custom GDB path in `launch.json`: `"gdbPath": "/custom/path/to/gdb"`

### Breakpoints Not Hitting
- Ensure application is compiled with debug symbols (`-g` flag)
- Verify source path mapping is correct in `sourceMap`
- Check that local source files match remote compiled version

### Connection Drops
- The extension will attempt to reconnect automatically
- Last known state (call stack, variables) is preserved
- If reconnection fails, restart the debug session

## Verbose Logging

Enable verbose logging for troubleshooting:

1. Open VSCode settings (`Cmd+,`)
2. Search for "Remote GDB"
3. Enable **Remote GDB: Logging: Verbose**
4. View logs in **Output → Remote GDB** panel

## Known Limitations

- Conditional breakpoints not yet supported
- Watchpoints (data breakpoints) not yet supported
- Multi-threaded debugging support is basic
- Reverse debugging not supported

## Contributing

Found a bug or have a feature request? Please open an issue on GitHub.

## License

MIT License - see LICENSE file for details
