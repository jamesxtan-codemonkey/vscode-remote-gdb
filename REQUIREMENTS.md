# Remote GDB VSCode Plugin - Requirements Document

## Project Overview

A VSCode extension that enables remote debugging of C/C++ applications on Linux machines via SSH from Mac OSX, using GDB with key-based authentication and the Debug Adapter Protocol (DAP).

---

## Platform Requirements

### Client Side (Development Machine)
- **Operating System**: Mac OSX
- **IDE**: VSCode 1.85.0 or higher
- **SSH Configuration**: Key-based authentication configured in `~/.ssh/config`
- **Network**: SSH access to remote Linux machines

### Server Side (Remote Machine)
- **Operating System**: Linux (any distribution)
- **GDB Version**: GDB 7.0 or higher with MI (Machine Interface) support
- **SSH Server**: Running with key-based authentication enabled
- **Target Application**: C/C++ executables compiled with debug symbols (`-g` flag)

---

## Core Requirements

### 1. Authentication & Connection
- **SSH Key-Based Authentication**: Use SSH keys from `~/.ssh/config`
- **Configuration Source**: Primary configuration from `~/.ssh/config`, with manual override support
- **Connection Management**:
  - Persistent SSH connection per debug session
  - Connection pooling for multiple sessions to same host
  - SSH multiplexing for performance
- **Security**: Basic SSH key authentication only (no passphrase support in v1)

### 2. Debug Modes

#### 2.1 Launch Mode
- Start a new process under GDB control on remote machine
- Support command-line arguments
- Support environment variables
- Support custom working directory
- Option to stop at entry point (main function)

#### 2.2 Attach Mode
- Attach GDB to an already-running process by PID
- Process picker UI to select from running processes
- Support attach by process name search

#### 2.3 Core Dump Analysis
- Load and analyze core dump files on remote machine
- View backtrace and variables at crash time
- Read-only mode (no execution control)

### 3. Source Code Synchronization
- **User Responsibility**: User manually syncs files between local and remote
- **Path Mapping**: Plugin handles source path translation
- **Configuration**: `sourceMap` in launch.json maps local paths to remote paths
- **VSCode Variables**: Support `${workspaceFolder}` variable in path mappings

### 4. Debugging Features (Basic Scope)

#### 4.1 Breakpoints
- Set/remove line breakpoints by clicking gutter
- Visual indicators (red dots for active, gray for disabled)
- Enable/disable breakpoints without removing
- Automatic sync between VSCode and remote GDB
- Breakpoint verification (valid/invalid source locations)

#### 4.2 Execution Control
- **Continue** (F5): Resume execution
- **Step Over** (F10): Execute next line, skip function calls
- **Step Into** (F11): Step into function calls
- **Step Out** (Shift+F11): Step out of current function
- **Pause**: Interrupt execution
- **Stop**: Terminate debug session and kill remote process
- **Restart**: Restart debug session

#### 4.3 Variable Inspection
- View local variables
- View function parameters
- View global variables (if available)
- View CPU registers (basic support)
- Expandable tree structure for structs/arrays/pointers
- Hover over variables in source to see values
- Value change highlighting during stepping

#### 4.4 Watch Expressions
- Add custom expressions to watch
- Expressions evaluated on remote machine via GDB
- Persistent across debug session

#### 4.5 Call Stack
- Display all stack frames with function names and line numbers
- Click frames to navigate and view local variables at that frame
- Show thread information for multi-threaded programs
- Source file mapping to jump to correct local file

#### 4.6 Debug Console
- Evaluate expressions interactively
- Execute GDB commands directly (e.g., `print variable`, `info registers`)
- View program stdout/stderr
- View GDB responses

### 5. VSCode Integration

#### 5.1 Debug UI Components (via DAP)
All standard VSCode debug views must work:
- Visual breakpoint indicators in editor gutter
- Variables panel (VARIABLES view)
- Call Stack panel (CALL STACK view)
- Watch panel (WATCH view)
- Breakpoints panel (BREAKPOINTS view)
- Debug toolbar (Continue, Step Over, Step Into, Step Out, Restart, Stop)
- Debug console
- Current execution line highlighting

#### 5.2 Configuration
Two configuration approaches:
1. **Manual JSON Editing**: Direct editing of `.vscode/launch.json` with IntelliSense
2. **Configuration Wizard**: Guided setup via webview UI

#### 5.3 Commands
- Command Palette: "Remote GDB: Create Debug Configuration"
- Command Palette: "Remote GDB: Pick Remote Process"
- Debugger selection in Run → Start Debugging

#### 5.4 Status Bar
- Show connection status (connected/disconnected)
- Quick access to configuration wizard
- Show during active debug session only

---

## User Answers & Decisions

### Source Synchronization
✅ **User manually syncs files** - Plugin only handles debugging, not file transfer

### Feature Scope
✅ **Basic debugging** - Breakpoints, step through, variable inspection, call stack (standard DAP features)

### SSH Configuration
✅ **Use .ssh/config** - Read SSH hosts from user's `~/.ssh/config` file

### Debug Modes Support
✅ **All three modes**:
- Launch mode (start new process)
- Attach mode (attach to running process)
- Core dump analysis

### Security
✅ **Basic SSH only** - Standard SSH key authentication, no additional security measures

### Connection Loss Handling
✅ **Graceful degradation**:
- Attempt to reconnect automatically
- If reconnection fails, preserve last known state (call stack, variables)
- Switch UI to read-only mode
- Notify user of disconnection

### Multi-Session Support
✅ **Yes, multiple sessions** - Allow debugging multiple programs on different remote machines simultaneously

### Language Support
✅ **C/C++ only** - Focus on C and C++ debugging with standard GDB

### Stop Behavior
✅ **Kill remote process** - Terminate the remote process when debug session ends

### Diagnostics & Logging
✅ **Full logging**:
- VSCode Output channel for extension logs
- Separate channel for GDB/MI commands and responses
- Verbose mode setting (on/off)

### GDB Version
✅ **Modern GDB (7.0+)** - Assume recent GDB with full MI protocol support

---

## Configuration Schema

### Required Fields
- `type`: "remote-gdb"
- `request`: "launch" | "attach"
- `name`: String (configuration name)
- `sshHost`: String (SSH host from ~/.ssh/config)
- `program`: String (remote executable path)

### Optional Fields

#### SSH Overrides
- `sshHostname`: String (override hostname from config)
- `sshPort`: Number (override port, default: 22)
- `sshUsername`: String (override username)
- `sshKeyFile`: String (override SSH key file path)

#### Launch/Attach Specific
- `args`: String[] (command-line arguments)
- `cwd`: String (working directory on remote)
- `env`: Object (environment variables)
- `processId`: String | Number (for attach mode)
- `coreDumpPath`: String (for core dump analysis)

#### GDB Settings
- `gdbPath`: String (default: "/usr/bin/gdb")
- `stopAtEntry`: Boolean (stop at main, default: false)
- `setupCommands`: String[] (GDB initialization commands)

#### Path Mapping
- `sourceMap`: Object (map local paths to remote paths)

#### Advanced
- `verbose`: Boolean (enable verbose logging, default: false)
- `timeout`: Number (SSH connection timeout in ms, default: 10000)

---

## Configuration Wizard Requirements

### Wizard Steps
1. **Debug Mode Selection**: Launch / Attach / Core Dump
2. **SSH Connection**: Select from ~/.ssh/config or manual entry, with connection test
3. **Program Settings**: Remote executable path, working directory, arguments, environment variables
4. **GDB Settings**: GDB path, setup commands, stop at entry option
5. **Source Path Mapping**: Map local source paths to remote paths
6. **Review & Save**: Preview generated JSON and save to launch.json

### UI Components
- Multi-step form with validation
- Remote file browser for selecting executables
- Process picker for attach mode (shows `ps aux` output)
- SSH connection tester
- Auto-generation of launch.json

---

## Technical Architecture

### Communication Flow
```
VSCode Debug UI
    ↕ (Debug Adapter Protocol - JSON-RPC)
Remote GDB Debug Adapter
    ├─ GDB/MI Parser
    ├─ SSH Connection Manager
    ├─ Path Mapper
    └─ Session Manager
    ↕ (SSH Connection - Port 22)
GDB on Remote Linux Machine
    ↕
Target Application (C/C++)
```

### Key Components
1. **Extension Entry Point** (`extension.ts`) - Activation, command registration
2. **Debug Adapter** (`debugAdapter.ts`) - DAP implementation
3. **GDB/MI Interface** (`gdbMI.ts`) - Parser and command generator
4. **SSH Manager** (`sshManager.ts`) - Connection handling with auto-reconnect
5. **Config Parser** (`configParser.ts`) - SSH config parsing
6. **Path Mapper** (`pathMapper.ts`) - Local ↔ remote path translation
7. **Logger** (`logger.ts`) - Diagnostic logging

### GDB/MI Protocol
- Use GDB Machine Interface mode: `gdb --interpreter=mi`
- Command format: `-exec-continue`, `-break-insert`, etc.
- Parse MI output records: result, stream, async

### DAP Implementation
Implement these DAP requests:
- `initialize`, `launch`, `attach`
- `setBreakpoints`, `setExceptionBreakpoints`
- `continue`, `next`, `stepIn`, `stepOut`, `pause`
- `stackTrace`, `scopes`, `variables`
- `evaluate`
- `disconnect`, `terminate`

Emit these DAP events:
- `initialized`, `stopped`, `continued`
- `terminated`, `exited`
- `output`, `breakpoint`, `thread`

---

## Non-Functional Requirements

### Performance
- SSH connection multiplexing for efficiency
- Connection pooling for multiple sessions to same host
- Minimal latency in breakpoint setting and variable inspection

### Reliability
- Auto-reconnect on connection loss (max 3 attempts)
- Graceful degradation when disconnected
- Error handling for all SSH and GDB operations
- Connection keepalive (30-second intervals)

### Usability
- Configuration wizard for beginners
- IntelliSense support for manual JSON editing
- Clear error messages with actionable suggestions
- Comprehensive documentation

### Maintainability
- TypeScript for type safety
- Modular architecture
- Comprehensive logging for debugging
- Unit tests for GDB/MI parser
- Integration tests with mock SSH/GDB

---

## Future Enhancements (Post-MVP)

Not required for initial version, but potential future features:
- Conditional breakpoints and hit counts
- Watchpoints (data breakpoints)
- Function breakpoints
- Memory viewer
- Disassembly view
- Reverse debugging (if GDB supports)
- LLDB support as alternative debugger
- Auto-sync option for source files
- SSH passphrase support
- Multi-threaded debugging enhancements
- Rust/Go language support

---

## Success Criteria

The plugin is successful when:
1. ✅ User can debug C/C++ apps on remote Linux from Mac VSCode
2. ✅ Full VSCode debug UI integration (all standard panels work)
3. ✅ Configuration wizard makes setup easy (<5 minutes for new users)
4. ✅ Multiple simultaneous debug sessions work reliably
5. ✅ Connection loss doesn't lose debugging context
6. ✅ Comprehensive logging helps troubleshoot issues
7. ✅ Documentation enables quick start without external help

---

## Known Limitations (v1.0)

1. **No SSH Passphrase Support**: Only passwordless SSH keys
2. **No Conditional Breakpoints**: Only line breakpoints
3. **No Watchpoints**: Data breakpoints not supported
4. **Basic Multi-threading**: Thread selection works but limited features
5. **No Reverse Debugging**: Forward execution only
6. **C/C++ Only**: Other languages not supported
7. **Manual File Sync**: No automatic source file synchronization
8. **Modern GDB Required**: GDB 7.0+ only

---

## Testing Requirements

### Manual Testing Scenarios
1. SSH connection to various Linux distributions
2. Launch mode with various programs
3. Attach mode to running processes
4. Core dump analysis
5. Breakpoint setting and hitting
6. Variable inspection at different stack frames
7. Multi-session debugging (2+ machines)
8. Connection loss and recovery
9. Configuration wizard flow
10. Different SSH key types (RSA, Ed25519, ECDSA)

### Automated Testing
1. Unit tests for GDB/MI parser
2. Unit tests for path mapper
3. Integration tests with mock SSH client
4. Integration tests with mock GDB responses

---

## Dependencies

### NPM Packages (Runtime)
- `ssh2` (^1.15.0) - SSH client implementation
- `@vscode/debugadapter` (^1.65.0) - DAP helpers
- `@vscode/debugprotocol` (^1.65.0) - DAP type definitions
- `ssh-config` (^4.4.2) - SSH config file parser

### NPM Packages (Development)
- `@types/vscode` (^1.85.0)
- `@types/node` (^20.10.0)
- `@types/ssh2` (^1.15.0)
- `typescript` (^5.3.0)
- `@vscode/vsce` (^2.22.0) - Extension packaging

### Remote Requirements
- GDB 7.0+ with MI support
- SSH server with key-based auth
- Linux operating system
- Executable compiled with `-g` flag

---

## Documentation Requirements

### User Documentation
1. **README.md**: Features, quick start, configuration, troubleshooting
2. **Configuration Examples**: All three debug modes
3. **SSH Setup Guide**: How to configure ~/.ssh/config
4. **Troubleshooting Guide**: Common issues and solutions
5. **FAQ**: Frequently asked questions

### Developer Documentation
1. **Architecture Overview**: Component diagram and flow
2. **GDB/MI Protocol**: Parser implementation details
3. **DAP Implementation**: Supported features
4. **Testing Guide**: How to run tests
5. **Contributing Guide**: How to contribute

---

## Delivery Artifacts

1. **Source Code**: Complete TypeScript implementation
2. **Compiled Extension**: `.vsix` package file
3. **Documentation**: README, guides, API docs
4. **Tests**: Unit and integration tests
5. **Examples**: Sample launch.json configurations
6. **License**: MIT License file

---

## Project Timeline (Reference)

### Phase 1: Foundation (Completed)
- ✅ Project structure and configuration
- ✅ TypeScript types and interfaces
- ✅ SSH connection manager
- ✅ SSH config parser
- ✅ GDB/MI parser
- ✅ Path mapper
- ✅ Logger

### Phase 2: Debug Adapter (Completed)
- ✅ DAP implementation
- ✅ Launch/attach/core dump modes
- ✅ Breakpoint management
- ✅ Execution control
- ✅ Variable inspection

### Phase 3: Extension Integration (Completed)
- ✅ Extension entry point
- ✅ Configuration provider
- ✅ Command registration
- ✅ Status bar integration

### Phase 4: Configuration UI (Pending)
- ⏳ Configuration wizard webview
- ⏳ Remote file browser
- ⏳ Process picker UI
- ⏳ JSON schema for IntelliSense

### Phase 5: Testing & Polish (Pending)
- ⏳ Unit tests
- ⏳ Integration tests
- ⏳ Manual testing
- ⏳ Documentation completion
- ⏳ Package and publish

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-01-19 | Initial | Initial requirements document |

---

## Appendix: Example Configurations

### Example 1: Simple Launch
```json
{
    "type": "remote-gdb",
    "request": "launch",
    "name": "Debug Remote App",
    "sshHost": "devserver",
    "program": "/home/user/myapp",
    "sourceMap": {
        "${workspaceFolder}": "/home/user/myapp"
    }
}
```

### Example 2: Launch with Arguments and Environment
```json
{
    "type": "remote-gdb",
    "request": "launch",
    "name": "Debug with Args",
    "sshHost": "devserver",
    "program": "/home/user/myapp",
    "args": ["--verbose", "--config", "/etc/app.conf"],
    "env": {
        "DEBUG": "1",
        "LOG_LEVEL": "trace"
    },
    "cwd": "/home/user/workspace",
    "stopAtEntry": true,
    "sourceMap": {
        "${workspaceFolder}": "/home/user/workspace"
    }
}
```

### Example 3: Attach to Process
```json
{
    "type": "remote-gdb",
    "request": "attach",
    "name": "Attach to Running Process",
    "sshHost": "prodserver",
    "program": "/opt/app/server",
    "processId": "${command:remote-gdb.pickRemoteProcess}",
    "sourceMap": {
        "${workspaceFolder}": "/opt/app/src"
    }
}
```

### Example 4: Core Dump Analysis
```json
{
    "type": "remote-gdb",
    "request": "launch",
    "name": "Analyze Core Dump",
    "sshHost": "devserver",
    "program": "/home/user/myapp",
    "coreDumpPath": "/tmp/core.12345",
    "sourceMap": {
        "${workspaceFolder}": "/home/user/myapp"
    }
}
```

### Example 5: Manual SSH Configuration
```json
{
    "type": "remote-gdb",
    "request": "launch",
    "name": "Manual SSH Config",
    "sshHost": "custom",
    "sshHostname": "192.168.1.100",
    "sshPort": 2222,
    "sshUsername": "developer",
    "sshKeyFile": "/Users/dev/.ssh/custom_key",
    "program": "/home/developer/app",
    "gdbPath": "/usr/local/bin/gdb",
    "setupCommands": [
        "set print pretty on",
        "set pagination off"
    ],
    "verbose": true,
    "sourceMap": {
        "${workspaceFolder}": "/home/developer/app"
    }
}
```
