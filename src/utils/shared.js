/**
 * Shared Utilities Module
 * Common functions used across multiple channels and modules
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

/**
 * Generate a cryptographically secure token
 * @param {number} length - Token length (default: 8)
 * @returns {string} Uppercase alphanumeric token
 */
function generateToken(length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = crypto.randomBytes(length);
    let token = '';
    for (let i = 0; i < length; i++) {
        token += chars[bytes[i] % chars.length];
    }
    return token;
}

/**
 * Find session by token in sessions directory
 * @param {string} token - Session token
 * @param {string} sessionsDir - Directory containing session files
 * @param {object} logger - Logger instance (optional)
 * @returns {object|null} Session object or null if not found
 */
function findSessionByToken(token, sessionsDir, logger = null) {
    if (!token || !sessionsDir) return null;

    try {
        const files = fs.readdirSync(sessionsDir);

        for (const file of files) {
            if (!file.endsWith('.json')) continue;

            const sessionPath = path.join(sessionsDir, file);
            try {
                const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                if (session.token === token) {
                    return session;
                }
            } catch (error) {
                if (logger) {
                    logger.error(`Failed to read session file ${file}:`, error.message);
                }
            }
        }
    } catch (error) {
        if (logger) {
            logger.error('Failed to read sessions directory:', error.message);
        }
    }

    return null;
}

/**
 * Copy text to clipboard (macOS)
 * @param {string} text - Text to copy
 * @returns {boolean} Success status
 */
function copyToClipboard(text) {
    if (process.platform !== 'darwin') {
        return false;
    }

    try {
        execSync('pbcopy', {
            input: text,
            encoding: 'utf8'
        });
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Get text from clipboard (macOS)
 * @returns {string|null} Clipboard content or null on error
 */
function getFromClipboard() {
    if (process.platform !== 'darwin') {
        return null;
    }

    try {
        return execSync('pbpaste', { encoding: 'utf8' });
    } catch (error) {
        return null;
    }
}

/**
 * Sanitize input to prevent command injection
 * Only allows alphanumeric, dash, underscore
 * @param {string} input - Input string
 * @returns {string} Sanitized string
 */
function sanitizeForShell(input) {
    if (!input || typeof input !== 'string') {
        return '';
    }
    return input.replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Escape string for shell single quotes
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeShellArg(str) {
    if (!str) return "''";
    return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Read session map with optional file locking awareness
 * @param {string} mapPath - Path to session map file
 * @returns {object} Session map object
 */
function readSessionMap(mapPath) {
    if (!fs.existsSync(mapPath)) {
        return {};
    }

    try {
        return JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    } catch (error) {
        return {};
    }
}

/**
 * Write session map atomically
 * @param {string} mapPath - Path to session map file
 * @param {object} data - Session map data
 */
function writeSessionMap(mapPath, data) {
    const tempPath = mapPath + '.tmp';
    const dir = path.dirname(mapPath);

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Write to temp file first, then rename (atomic on most systems)
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, mapPath);
}

/**
 * Get current tmux session name
 * @returns {string|null} Session name or null if not in tmux
 */
function getCurrentTmuxSession() {
    try {
        const tmuxSession = execFileSync('tmux', ['display-message', '-p', '#S'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        return tmuxSession || null;
    } catch (error) {
        // Not in a tmux session or tmux not available
        return null;
    }
}

/**
 * Check if tmux is available on the system
 * @returns {boolean} True if tmux is available
 */
function isTmuxAvailable() {
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
 * Escape string for AppleScript (used for osascript)
 * @param {string} str - String to escape
 * @returns {string} Escaped string safe for AppleScript
 */
function escapeForAppleScript(str) {
    if (!str) return '';
    return str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

/**
 * Sanitize tmux session name - remove dangerous characters
 * @param {string} name - Session name to sanitize
 * @returns {string} Sanitized session name
 */
function sanitizeSessionName(name) {
    if (!name || typeof name !== 'string') {
        return '';
    }
    // Remove dangerous shell characters: ; ` $ ( ) | & < > newlines
    return name.replace(/[;`$()|\n\r&<>]/g, '');
}

module.exports = {
    generateToken,
    findSessionByToken,
    copyToClipboard,
    getFromClipboard,
    sanitizeForShell,
    escapeShellArg,
    readSessionMap,
    writeSessionMap,
    getCurrentTmuxSession,
    isTmuxAvailable,
    escapeForAppleScript,
    sanitizeSessionName
};
