#!/usr/bin/env node

/**
 * Tmux Command Injector - Unattended remote control solution
 * Security hardened version using execFileSync with argument arrays
 */

const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
    sanitizeSessionName,
    escapeForAppleScript,
    isTmuxAvailable
} = require('../utils/shared');

class TmuxInjector {
    constructor(logger, sessionName = null) {
        this.log = logger || console;
        // Sanitize session name to prevent injection
        const rawName = sessionName || 'claude-taskping';
        this.sessionName = sanitizeSessionName(rawName);
        if (this.sessionName !== rawName) {
            this.log.warn(`Session name sanitized: "${rawName}" -> "${this.sessionName}"`);
        }
        this.logFile = path.join(__dirname, '../logs/tmux-injection.log');
        this.ensureLogDir();
    }

    ensureLogDir() {
        const logDir = path.dirname(this.logFile);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
    }

    /**
     * Check if tmux is installed (synchronous version for quick checks)
     * @returns {boolean} True if tmux is available
     */
    checkTmuxAvailableSync() {
        return isTmuxAvailable();
    }

    /**
     * Check if tmux is installed
     * @returns {Promise<boolean>} True if tmux is available
     */
    async checkTmuxAvailable() {
        return new Promise((resolve) => {
            try {
                execFileSync('which', ['tmux'], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore']
                });
                resolve(true);
            } catch (error) {
                resolve(false);
            }
        });
    }

    /**
     * Check if Claude tmux session exists
     * @returns {Promise<boolean>} True if session exists
     */
    async checkClaudeSession() {
        return new Promise((resolve) => {
            try {
                execFileSync('tmux', ['has-session', '-t', this.sessionName], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore']
                });
                resolve(true);
            } catch (error) {
                resolve(false);
            }
        });
    }

    /**
     * Create Claude tmux session
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async createClaudeSession() {
        return new Promise((resolve) => {
            const cwd = process.cwd();

            this.log.info(`Creating tmux session: ${this.sessionName} in ${cwd}`);

            try {
                // Try with clauderun first
                execFileSync('tmux', [
                    'new-session', '-d',
                    '-s', this.sessionName,
                    '-c', cwd,
                    'clauderun'
                ], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                this.log.info('Tmux Claude session created successfully (clauderun)');
                // Wait for Claude initialization
                setTimeout(() => {
                    resolve({ success: true });
                }, 3000);
            } catch (error) {
                this.log.warn(`Failed to create tmux session with clauderun: ${error.message}`);
                this.log.info('Fallback to claude from PATH...');

                try {
                    // Fallback to claude
                    execFileSync('tmux', [
                        'new-session', '-d',
                        '-s', this.sessionName,
                        '-c', cwd,
                        'claude'
                    ], {
                        encoding: 'utf8',
                        stdio: ['ignore', 'pipe', 'pipe']
                    });

                    this.log.info('Tmux Claude session created successfully (claude)');
                    setTimeout(() => {
                        resolve({ success: true });
                    }, 3000);
                } catch (fallbackError) {
                    this.log.error(`Failed to create tmux session with fallback: ${fallbackError.message}`);
                    resolve({ success: false, error: fallbackError.message });
                }
            }
        });
    }

    /**
     * Send keys to tmux session (internal helper)
     * @param {string[]} keys - Keys to send
     * @returns {boolean} Success status
     */
    _sendKeysSync(keys) {
        try {
            execFileSync('tmux', ['send-keys', '-t', this.sessionName, ...keys], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe']
            });
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Inject command into tmux session (intelligently handle Claude confirmations)
     * @param {string} command - Command to inject
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async injectCommand(command) {
        return new Promise(async (resolve) => {
            try {
                this.log.debug(`Injecting command via tmux: ${command}`);

                // 1. Clear input field (Ctrl-U)
                if (!this._sendKeysSync(['C-u'])) {
                    this.log.error('Failed to clear input');
                    resolve({ success: false, error: 'Failed to clear input' });
                    return;
                }

                // Brief wait
                await new Promise(r => setTimeout(r, 200));

                // 2. Send command text
                // Note: tmux send-keys handles the text directly without shell interpretation
                if (!this._sendKeysSync([command])) {
                    this.log.error('Failed to send command');
                    resolve({ success: false, error: 'Failed to send command' });
                    return;
                }

                // Brief wait
                await new Promise(r => setTimeout(r, 200));

                // 3. Send enter (Ctrl-M or Enter)
                if (!this._sendKeysSync(['C-m'])) {
                    this.log.error('Failed to send enter');
                    resolve({ success: false, error: 'Failed to send enter' });
                    return;
                }

                this.log.debug('Command sent successfully in 3 steps');

                // Brief wait for command sending
                await new Promise(r => setTimeout(r, 1000));

                // Check if command is already displayed in Claude
                const capture = await this.getCaptureOutput();
                if (capture.success) {
                    this.log.debug(`Claude state after injection: ${capture.output.slice(-200).replace(/\n/g, ' ')}`);
                }

                // Wait and check if confirmation is needed
                await this.handleConfirmations();

                // Record injection log
                this.logInjection(command);

                resolve({ success: true });

            } catch (error) {
                resolve({ success: false, error: error.message });
            }
        });
    }

    /**
     * Automatically handle Claude confirmation dialogs
     */
    async handleConfirmations() {
        const maxAttempts = 8;
        let attempts = 0;

        while (attempts < maxAttempts) {
            attempts++;

            // Wait for Claude processing
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Get current screen content
            const capture = await this.getCaptureOutput();

            if (!capture.success) {
                break;
            }

            const output = capture.output;
            this.log.debug(`Confirmation check ${attempts}: ${output.slice(-200).replace(/\n/g, ' ')}`);

            // Check for multi-option confirmation dialog (priority handling)
            if (output.includes('Do you want to proceed?') &&
                (output.includes('1. Yes') || output.includes('2. Yes, and don\'t ask again'))) {

                this.log.info(`Detected multi-option confirmation, selecting option 2 (attempt ${attempts})`);

                // Select "2. Yes, and don't ask again" to avoid future confirmation dialogs
                this._sendKeysSync(['2']);
                await new Promise(r => setTimeout(r, 300));
                this._sendKeysSync(['Enter']);
                this.log.info('Auto-confirmation sent (option 2)');

                // Wait for confirmation to take effect
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
            }

            // Check for single option confirmation
            if (output.includes('❯ 1. Yes') || output.includes('▷ 1. Yes')) {
                this.log.info(`Detected single option confirmation, selecting option 1 (attempt ${attempts})`);

                this._sendKeysSync(['1']);
                await new Promise(r => setTimeout(r, 300));
                this._sendKeysSync(['Enter']);
                this.log.info('Auto-confirmation sent (option 1)');

                continue;
            }

            // Check for simple Y/N confirmation
            if (output.includes('(y/n)') || output.includes('[Y/n]') || output.includes('[y/N]')) {
                this.log.info(`Detected y/n prompt, sending 'y' (attempt ${attempts})`);

                this._sendKeysSync(['y']);
                await new Promise(r => setTimeout(r, 300));
                this._sendKeysSync(['Enter']);
                this.log.info('Auto-confirmation sent (y)');

                continue;
            }

            // Check for press Enter to continue prompts
            if (output.includes('Press Enter to continue') ||
                output.includes('Enter to confirm') ||
                output.includes('Press Enter')) {
                this.log.info(`Detected Enter prompt, sending Enter (attempt ${attempts})`);

                this._sendKeysSync(['Enter']);
                this.log.info('Auto-Enter sent');

                continue;
            }

            // Check if command is currently executing
            if (output.includes('Clauding…') ||
                output.includes('Waiting…') ||
                output.includes('Processing…') ||
                output.includes('Working…')) {
                this.log.info('Command appears to be executing, waiting...');
                continue;
            }

            // Check for new empty input box (indicates completion)
            if ((output.includes('│ >') || output.includes('> ')) &&
                !output.includes('Do you want to proceed?') &&
                !output.includes('1. Yes') &&
                !output.includes('(y/n)')) {
                this.log.debug('New input prompt detected, command likely completed');
                break;
            }

            // Check for error messages
            if (output.includes('Error:') || output.includes('error:') || output.includes('failed')) {
                this.log.warn('Detected error in output, stopping confirmation attempts');
                break;
            }

            // If nothing detected, wait longer before checking again
            if (attempts < maxAttempts) {
                this.log.info('No confirmation prompts detected, waiting longer...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        this.log.info(`Confirmation handling completed after ${attempts} attempts`);

        // Final state check
        const finalCapture = await this.getCaptureOutput();
        if (finalCapture.success) {
            this.log.debug(`Final state: ${finalCapture.output.slice(-100).replace(/\n/g, ' ')}`);
        }
    }

    /**
     * Get tmux session output
     * @returns {Promise<{success: boolean, output?: string, error?: string}>}
     */
    async getCaptureOutput() {
        return new Promise((resolve) => {
            try {
                const output = execFileSync('tmux', [
                    'capture-pane', '-t', this.sessionName, '-p'
                ], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                resolve({ success: true, output });
            } catch (error) {
                resolve({ success: false, error: error.message });
            }
        });
    }

    /**
     * Restart Claude session
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async restartClaudeSession() {
        return new Promise(async (resolve) => {
            this.log.info('Restarting Claude tmux session...');

            // Kill existing session
            try {
                execFileSync('tmux', ['kill-session', '-t', this.sessionName], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe']
                });
            } catch (error) {
                // Session might not exist, that's okay
            }

            // Wait a moment
            await new Promise(r => setTimeout(r, 1000));

            // Create new session
            const result = await this.createClaudeSession();
            resolve(result);
        });
    }

    /**
     * Complete command injection workflow
     * @param {string} token - Session token
     * @param {string} command - Command to inject
     * @returns {Promise<{success: boolean, error?: string, message?: string, session?: string}>}
     */
    async injectCommandFull(token, command) {
        try {
            this.log.debug(`Starting tmux command injection (Token: ${token})`);

            // 1. Check if tmux is available
            const tmuxAvailable = await this.checkTmuxAvailable();
            if (!tmuxAvailable) {
                return { success: false, error: 'tmux_not_installed', message: 'Need to install tmux: brew install tmux' };
            }

            // 2. Check if Claude session exists
            const sessionExists = await this.checkClaudeSession();

            if (!sessionExists) {
                this.log.warn('Claude tmux session not found, creating new session...');
                const createResult = await this.createClaudeSession();

                if (!createResult.success) {
                    return { success: false, error: 'session_creation_failed', message: createResult.error };
                }
            }

            // 3. Inject command
            const injectResult = await this.injectCommand(command);

            if (injectResult.success) {
                // 4. Send success notification
                await this.sendSuccessNotification(command);

                return {
                    success: true,
                    message: 'Command successfully injected into Claude tmux session',
                    session: this.sessionName
                };
            } else {
                return {
                    success: false,
                    error: 'injection_failed',
                    message: injectResult.error
                };
            }

        } catch (error) {
            this.log.error(`Tmux injection error: ${error.message}`);
            return { success: false, error: 'unexpected_error', message: error.message };
        }
    }

    /**
     * Send success notification via osascript
     * @param {string} command - The command that was injected
     */
    async sendSuccessNotification(command) {
        // Only works on macOS
        if (process.platform !== 'darwin') {
            return;
        }

        const shortCommand = command.length > 30 ? command.substring(0, 30) + '...' : command;
        const escapedSubtitle = escapeForAppleScript(shortCommand);

        const notificationScript = `display notification "🎉 Command automatically injected into Claude! No manual operation needed" with title "TaskPing Remote Control Success" subtitle "${escapedSubtitle}" sound name "Glass"`;

        try {
            // Use execFile with script as argument, not exec with shell interpolation
            execFile('osascript', ['-e', notificationScript], (error) => {
                if (error) {
                    this.log.warn('Failed to send success notification');
                } else {
                    this.log.info('Success notification sent');
                }
            });
        } catch (error) {
            this.log.warn('Failed to send success notification');
        }
    }

    /**
     * Record injection log
     * @param {string} command - The command that was injected
     */
    logInjection(command) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            command: command,
            session: this.sessionName,
            pid: process.pid
        };

        const logLine = JSON.stringify(logEntry) + '\n';

        try {
            fs.appendFileSync(this.logFile, logLine);
        } catch (error) {
            this.log.warn(`Failed to write injection log: ${error.message}`);
        }
    }

    /**
     * Get session status information
     * @returns {Promise<{exists: boolean, info?: string, name?: string}>}
     */
    async getSessionInfo() {
        return new Promise((resolve) => {
            try {
                const output = execFileSync('tmux', ['list-sessions'], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                // Filter for our session
                const lines = output.split('\n');
                const sessionLine = lines.find(line => line.includes(this.sessionName));

                if (sessionLine) {
                    resolve({
                        exists: true,
                        info: sessionLine.trim(),
                        name: this.sessionName
                    });
                } else {
                    resolve({ exists: false });
                }
            } catch (error) {
                resolve({ exists: false });
            }
        });
    }
}

module.exports = TmuxInjector;
