import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Maps paths between local and remote filesystems
 */
export class PathMapper {
    private localToRemote: Map<string, string> = new Map();
    private remoteToLocal: Map<string, string> = new Map();

    constructor(sourceMap?: { [localPath: string]: string }) {
        if (sourceMap) {
            for (const [local, remote] of Object.entries(sourceMap)) {
                this.addMapping(local, remote);
            }
        }
    }

    /**
     * Add a path mapping
     */
    addMapping(localPath: string, remotePath: string): void {
        // Resolve VSCode variables like ${workspaceFolder}
        const resolvedLocal = this.resolveLocalPath(localPath);
        const normalizedLocal = this.normalizePath(resolvedLocal);
        const normalizedRemote = this.normalizePath(remotePath);

        this.localToRemote.set(normalizedLocal, normalizedRemote);
        this.remoteToLocal.set(normalizedRemote, normalizedLocal);
    }

    /**
     * Convert local path to remote path
     */
    toRemotePath(localPath: string): string {
        const normalized = this.normalizePath(localPath);

        // Try exact match first
        for (const [local, remote] of this.localToRemote.entries()) {
            if (normalized === local) {
                return remote;
            }
            // Try prefix match
            if (normalized.startsWith(local + '/')) {
                const relativePath = normalized.substring(local.length + 1);
                return remote + '/' + relativePath;
            }
        }

        // No mapping found, return as-is
        return localPath;
    }

    /**
     * Convert remote path to local path
     */
    toLocalPath(remotePath: string): string {
        const normalized = this.normalizePath(remotePath);

        // Try exact match first
        for (const [remote, local] of this.remoteToLocal.entries()) {
            if (normalized === remote) {
                return local;
            }
            // Try prefix match
            if (normalized.startsWith(remote + '/')) {
                const relativePath = normalized.substring(remote.length + 1);
                return path.join(local, relativePath);
            }
        }

        // No mapping found, return as-is (will likely fail)
        return remotePath;
    }

    /**
     * Normalize path for consistent comparison
     */
    private normalizePath(p: string): string {
        // Convert Windows backslashes to forward slashes
        let normalized = p.replace(/\\/g, '/');
        // Remove trailing slash
        if (normalized.endsWith('/') && normalized.length > 1) {
            normalized = normalized.substring(0, normalized.length - 1);
        }
        return normalized;
    }

    /**
     * Resolve VSCode variables in local paths
     */
    private resolveLocalPath(localPath: string): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return localPath;
        }

        const workspaceFolder = workspaceFolders[0].uri.fsPath;
        return localPath.replace(/\$\{workspaceFolder\}/g, workspaceFolder);
    }
}
