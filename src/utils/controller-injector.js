/**
 * Controller Injector
 * Injects commands into tmux sessions or PTY
 * Security-hardened version using execFileSync instead of shell string interpolation
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const Logger = require('../core/logger');
const {
    validateCommand,
    safeParseJSON,
    escapeForAppleScript,
    RateLimiter,
    MAX_COMMAND_LENGTH,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX_COMMANDS
} = require('./webhook-utils');

class ControllerInjector {
    constructor(config = {}) {
        this.logger = new Logger('ControllerInjector');
        this.mode = config.mode || process.env.INJECTION_MODE || 'pty';
        this.defaultSession = config.defaultSession || process.env.TMUX_SESSION || 'claude-code';
        this.sessionMapPath = process.env.SESSION_MAP_PATH ||
                              path.join(__dirname, '../../session-map.json');

        // Rate limiting
        this.rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_COMMANDS);
    }

    /**
     * Sanitize session name to prevent command injection
     * Only allows alphanumeric, dash, underscore
     */
    _sanitizeSessionName(name) {
        if (!name || typeof name !== 'string') {
            throw new Error('Invalid session name');
        }
        const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '');
        if (sanitized !== name) {
            this.logger.warn(`Session name sanitized: "${name}" -> "${sanitized}"`);
        }
        if (!sanitized) {
            throw new Error('Session name contains no valid characters');
        }
        return sanitized;
    }

    async injectCommand(command, sessionName = null) {
        const validation = validateCommand(command);
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        const validatedCommand = validation.command;
        const session = this._sanitizeSessionName(sessionName || this.defaultSession);

        // Check rate limit
        if (!this.rateLimiter.checkAndRecord(session)) {
            throw new Error(`Rate limit exceeded for session '${session}'. Please wait before sending more commands.`);
        }

        if (this.mode === 'tmux') {
            return this._injectTmux(validatedCommand, session);
        } else {
            return this._injectPty(validatedCommand, session);
        }
    }

    /**
     * Check if tmux session exists using execFileSync
     * @param {string} sessionName - Sanitized session name
     * @returns {boolean}
     */
    _tmuxSessionExists(sessionName) {
        try {
            execFileSync('tmux', ['has-session', '-t', sessionName], {
                stdio: 'ignore',
                timeout: 5000
            });
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Send keys to tmux session using execFileSync
     * @param {string} sessionName - Sanitized session name
     * @param {string} keys - Keys to send
     */
    _tmuxSendKeys(sessionName, keys) {
        execFileSync('tmux', ['send-keys', '-t', sessionName, keys], {
            timeout: 5000
        });
    }

    /**
     * Send literal keys to tmux session
     * @param {string} sessionName - Sanitized session name
     * @param {string} key - Key name (e.g., 'Enter')
     */
    _tmuxSendLiteralKey(sessionName, key) {
        execFileSync('tmux', ['send-keys', '-t', sessionName, key], {
            timeout: 5000
        });
    }

    _injectTmux(command, sessionName) {
        try {
            // Check if tmux session exists
            if (!this._tmuxSessionExists(sessionName)) {
                throw new Error(`Tmux session '${sessionName}' not found`);
            }

            // Send command to tmux session
            // Using send-keys with the command as a single argument (safe)
            this._tmuxSendKeys(sessionName, command);

            // Send Enter as separate command
            this._tmuxSendLiteralKey(sessionName, 'Enter');

            this.logger.info(`Command injected to tmux session '${sessionName}'`);
            return true;
        } catch (error) {
            this.logger.error('Failed to inject command via tmux:', error.message);
            throw error;
        }
    }

    _injectPty(command, sessionName) {
        // Get PTY path from session map
        let ptyPath = null;

        if (fs.existsSync(this.sessionMapPath)) {
            const content = fs.readFileSync(this.sessionMapPath, 'utf8');
            const sessionMap = safeParseJSON(content);
            if (sessionMap && sessionMap[sessionName] && sessionMap[sessionName].ptyPath) {
                ptyPath = sessionMap[sessionName].ptyPath;
            }
        }

        if (!ptyPath) {
            throw new Error(`Session '${sessionName}' not found`);
        }

        // Send to iTerm2 via AppleScript
        const ttyName = ptyPath.replace('/dev/', '');
        const escapedCommand = escapeForAppleScript(command);
        const escapedTtyName = escapeForAppleScript(ttyName);

        const script = `
            tell application "iTerm2"
                repeat with aWindow in windows
                    repeat with aTab in tabs of aWindow
                        repeat with aSession in sessions of aTab
                            if tty of aSession contains "${escapedTtyName}" then
                                select aSession
                                tell aSession
                                    write text "${escapedCommand}" without newline
                                end tell
                                tell application "System Events"
                                    tell process "iTerm2"
                                        keystroke return
                                    end tell
                                end tell
                                return "sent"
                            end if
                        end repeat
                    end repeat
                end repeat
                return "not found"
            end tell
        `;

        // Use execFileSync with osascript to avoid shell injection
        const result = execFileSync('osascript', ['-e', script], {
            encoding: 'utf8',
            timeout: 5000
        }).trim();

        if (result === 'sent') {
            this.logger.info(`Command sent to iTerm2 session ${ttyName}`);
            return true;
        }

        throw new Error(`iTerm2 session with TTY ${ttyName} not found`);
    }

    listSessions() {
        if (this.mode === 'tmux') {
            try {
                const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore']
                });
                return output.trim().split('\n').filter(Boolean);
            } catch (error) {
                return [];
            }
        } else {
            try {
                if (!fs.existsSync(this.sessionMapPath)) {
                    return [];
                }

                const content = fs.readFileSync(this.sessionMapPath, 'utf8');
                const sessionMap = safeParseJSON(content);
                return sessionMap ? Object.keys(sessionMap) : [];
            } catch (error) {
                this.logger.error(`Failed to list sessions: ${error.message}`);
                return [];
            }
        }
    }
}

module.exports = ControllerInjector;
