import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import SSHConfig from 'ssh-config';
import { SSHConnectionDetails } from './types/config';
import { logger } from './utils/logger';

/**
 * Parse SSH configuration from ~/.ssh/config
 */
export class ConfigParser {
    private config: SSHConfig | null = null;

    constructor() {
        this.loadSSHConfig();
    }

    /**
     * Load ~/.ssh/config file
     */
    private loadSSHConfig(): void {
        try {
            const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
            if (fs.existsSync(sshConfigPath)) {
                const configContent = fs.readFileSync(sshConfigPath, 'utf-8');
                this.config = SSHConfig.parse(configContent);
                logger.debug('SSH config loaded successfully');
            } else {
                logger.warn('SSH config file not found at ' + sshConfigPath);
            }
        } catch (error) {
            logger.error('Failed to load SSH config', error);
        }
    }

    /**
     * Get SSH connection details for a host
     */
    getConnectionDetails(
        hostAlias: string,
        overrides?: {
            hostname?: string;
            port?: number;
            username?: string;
            privateKeyPath?: string;
        }
    ): SSHConnectionDetails {
        let hostname = hostAlias;
        let port = 22;
        let username = os.userInfo().username;
        let privateKeyPath: string | undefined;

        // Try to find host in SSH config
        if (this.config) {
            const hostConfig = this.config.find({ Host: hostAlias });
            if (hostConfig) {
                hostname = this.getConfigValue(hostConfig, 'HostName') || hostAlias;
                const portStr = this.getConfigValue(hostConfig, 'Port');
                if (portStr) {
                    port = parseInt(portStr, 10);
                }
                username = this.getConfigValue(hostConfig, 'User') || username;
                const identityFile = this.getConfigValue(hostConfig, 'IdentityFile');
                if (identityFile) {
                    privateKeyPath = this.expandPath(identityFile);
                }
            }
        }

        // Apply overrides
        if (overrides) {
            if (overrides.hostname) {
                hostname = overrides.hostname;
            }
            if (overrides.port) {
                port = overrides.port;
            }
            if (overrides.username) {
                username = overrides.username;
            }
            if (overrides.privateKeyPath) {
                privateKeyPath = this.expandPath(overrides.privateKeyPath);
            }
        }

        // Default private key paths if not specified
        if (!privateKeyPath) {
            const defaultKeys = [
                path.join(os.homedir(), '.ssh', 'id_rsa'),
                path.join(os.homedir(), '.ssh', 'id_ed25519'),
                path.join(os.homedir(), '.ssh', 'id_ecdsa')
            ];
            for (const keyPath of defaultKeys) {
                if (fs.existsSync(keyPath)) {
                    privateKeyPath = keyPath;
                    break;
                }
            }
        }

        logger.debug('SSH connection details', {
            host: hostAlias,
            hostname,
            port,
            username,
            privateKeyPath
        });

        return {
            host: hostAlias,
            hostname,
            port,
            username,
            privateKeyPath
        };
    }

    /**
     * Get available SSH hosts from config
     */
    getAvailableHosts(): string[] {
        if (!this.config) {
            return [];
        }

        const hosts: string[] = [];
        for (const section of this.config) {
            if ('param' in section && section.param === 'Host' && 'value' in section && section.value && typeof section.value === 'string') {
                // Filter out wildcard patterns
                if (!section.value.includes('*') && !section.value.includes('?')) {
                    hosts.push(section.value);
                }
            }
        }

        return hosts;
    }

    /**
     * Get config value from host section
     */
    private getConfigValue(section: any, key: string): string | undefined {
        const config = section.config || section;
        for (const line of config) {
            if ('param' in line && 'value' in line && line.param === key && line.value) {
                return typeof line.value === 'string' ? line.value : line.value.toString();
            }
        }
        return undefined;
    }

    /**
     * Expand ~ in paths
     */
    private expandPath(p: string): string {
        if (p.startsWith('~/')) {
            return path.join(os.homedir(), p.substring(2));
        }
        return p;
    }
}
