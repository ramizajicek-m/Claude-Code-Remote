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
     * @returns {boolean} True if tmux is available
     */
    checkTmuxAvailable() {
        try {
            execFileSync('which', ['tmux'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Check if Claude tmux session exists
     * @returns {boolean} True if session exists
     */
    checkClaudeSession() {
        try {
            execFileSync('tmux', ['has-session', '-t', this.sessionName], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Helper to create a delay promise
     * @param {number} ms - Milliseconds to wait
     * @returns {Promise<void>}
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Create Claude tmux session
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async createClaudeSession() {
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
            await this._delay(3000);
            return { success: true };
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
                await this._delay(3000);
                return { success: true };
            } catch (fallbackError) {
                this.log.error(`Failed to create tmux session with fallback: ${fallbackError.message}`);
                return { success: false, error: fallbackError.message };
            }
        }
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
        try {
            this.log.debug(`Injecting command via tmux: ${command}`);

            // 1. Clear input field (Ctrl-U)
            if (!this._sendKeysSync(['C-u'])) {
                this.log.error('Failed to clear input');
                return { success: false, error: 'Failed to clear input' };
            }

            // Brief wait
            await this._delay(200);

            // 2. Send command text
            // Note: tmux send-keys handles the text directly without shell interpretation
            if (!this._sendKeysSync([command])) {
                this.log.error('Failed to send command');
                return { success: false, error: 'Failed to send command' };
            }

            // Brief wait
            await this._delay(200);

            // 3. Send enter (Ctrl-M or Enter)
            if (!this._sendKeysSync(['C-m'])) {
                this.log.error('Failed to send enter');
                return { success: false, error: 'Failed to send enter' };
            }

            this.log.debug('Command sent successfully in 3 steps');

            // Brief wait for command sending
            await this._delay(1000);

            // Check if command is already displayed in Claude
            const capture = this.getCaptureOutput();
            if (capture.success) {
                this.log.debug(`Claude state after injection: ${capture.output.slice(-200).replace(/\n/g, ' ')}`);
            }

            // Wait and check if confirmation is needed
            await this.handleConfirmations();

            // Record injection log
            this.logInjection(command);

            return { success: true };

        } catch (error) {
            return { success: false, error: error.message };
        }
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
            await this._delay(1500);

            // Get current screen content
            const capture = this.getCaptureOutput();

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
                await this._delay(300);
                this._sendKeysSync(['Enter']);
                this.log.info('Auto-confirmation sent (option 2)');

                // Wait for confirmation to take effect
                await this._delay(2000);
                continue;
            }

            // Check for single option confirmation
            if (output.includes('❯ 1. Yes') || output.includes('▷ 1. Yes')) {
                this.log.info(`Detected single option confirmation, selecting option 1 (attempt ${attempts})`);

                this._sendKeysSync(['1']);
                await this._delay(300);
                this._sendKeysSync(['Enter']);
                this.log.info('Auto-confirmation sent (option 1)');

                continue;
            }

            // Check for simple Y/N confirmation
            if (output.includes('(y/n)') || output.includes('[Y/n]') || output.includes('[y/N]')) {
                this.log.info(`Detected y/n prompt, sending 'y' (attempt ${attempts})`);

                this._sendKeysSync(['y']);
                await this._delay(300);
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
                await this._delay(2000);
            }
        }

        this.log.info(`Confirmation handling completed after ${attempts} attempts`);

        // Final state check
        const finalCapture = this.getCaptureOutput();
        if (finalCapture.success) {
            this.log.debug(`Final state: ${finalCapture.output.slice(-100).replace(/\n/g, ' ')}`);
        }
    }

    /**
     * Get tmux session output
     * @returns {{success: boolean, output?: string, error?: string}}
     */
    getCaptureOutput() {
        try {
            const output = execFileSync('tmux', [
                'capture-pane', '-t', this.sessionName, '-p'
            ], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe']
            });
            return { success: true, output };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Restart Claude session
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async restartClaudeSession() {
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
        await this._delay(1000);

        // Create new session
        return this.createClaudeSession();
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
            if (!this.checkTmuxAvailable()) {
                return { success: false, error: 'tmux_not_installed', message: 'Need to install tmux: brew install tmux' };
            }

            // 2. Check if Claude session exists
            if (!this.checkClaudeSession()) {
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
                this.sendSuccessNotification(command);

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
     * @returns {{exists: boolean, info?: string, name?: string}}
     */
    getSessionInfo() {
        try {
            const output = execFileSync('tmux', ['list-sessions'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe']
            });

            // Filter for our session
            const lines = output.split('\n');
            const sessionLine = lines.find(line => line.includes(this.sessionName));

            if (sessionLine) {
                return {
                    exists: true,
                    info: sessionLine.trim(),
                    name: this.sessionName
                };
            } else {
                return { exists: false };
            }
        } catch (error) {
            return { exists: false };
        }
    }
}

module.exports = TmuxInjector;
