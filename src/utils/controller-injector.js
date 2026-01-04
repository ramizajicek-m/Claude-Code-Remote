/**
 * Controller Injector
 * Injects commands into tmux sessions or PTY
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const Logger = require('../core/logger');

class ControllerInjector {
    constructor(config = {}) {
        this.logger = new Logger('ControllerInjector');
        this.mode = config.mode || process.env.INJECTION_MODE || 'pty';
        this.defaultSession = config.defaultSession || process.env.TMUX_SESSION || 'claude-code';
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

    /**
     * Escape string for AppleScript
     */
    _escapeForAppleScript(str) {
        return str
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t');
    }

    async injectCommand(command, sessionName = null) {
        const session = this._sanitizeSessionName(sessionName || this.defaultSession);

        if (this.mode === 'tmux') {
            return this._injectTmux(command, session);
        } else {
            return this._injectPty(command, session);
        }
    }

    _injectTmux(command, sessionName) {
        try {
            // Check if tmux session exists (sessionName already sanitized)
            try {
                execSync(`tmux has-session -t "${sessionName}"`, { stdio: 'ignore' });
            } catch (error) {
                throw new Error(`Tmux session '${sessionName}' not found`);
            }

            // Send command to tmux session and execute it
            const escapedCommand = command.replace(/'/g, "'\\''");

            // Send command first
            execSync(`tmux send-keys -t "${sessionName}" '${escapedCommand}'`);
            // Then send Enter as separate command
            execSync(`tmux send-keys -t "${sessionName}" Enter`);

            this.logger.info(`Command injected to tmux session '${sessionName}'`);
            return true;
        } catch (error) {
            this.logger.error('Failed to inject command via tmux:', error.message);
            throw error;
        }
    }

    _injectPty(command, sessionName) {
        // Get PTY path from session map
        const sessionMapPath = process.env.SESSION_MAP_PATH ||
                               path.join(__dirname, '../../session-map.json');

        let ptyPath = null;

        if (fs.existsSync(sessionMapPath)) {
            const sessionMap = JSON.parse(fs.readFileSync(sessionMapPath, 'utf8'));
            if (sessionMap[sessionName] && sessionMap[sessionName].ptyPath) {
                ptyPath = sessionMap[sessionName].ptyPath;
            }
        }

        if (!ptyPath) {
            throw new Error(`Session '${sessionName}' not found`);
        }

        // Send to iTerm2 via AppleScript
        const ttyName = ptyPath.replace('/dev/', '');
        const escapedCommand = this._escapeForAppleScript(command);
        const escapedTtyName = this._escapeForAppleScript(ttyName);

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

        const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
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
                const output = execSync('tmux list-sessions -F "#{session_name}"', { 
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore']
                });
                return output.trim().split('\n').filter(Boolean);
            } catch (error) {
                return [];
            }
        } else {
            try {
                const sessionMapPath = process.env.SESSION_MAP_PATH || 
                                       path.join(__dirname, '../data/session-map.json');
                
                if (!fs.existsSync(sessionMapPath)) {
                    return [];
                }

                const sessionMap = JSON.parse(fs.readFileSync(sessionMapPath, 'utf8'));
                return Object.keys(sessionMap);
            } catch (error) {
                return [];
            }
        }
    }
}

module.exports = ControllerInjector;