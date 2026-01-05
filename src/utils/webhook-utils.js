/**
 * Shared Webhook Utilities
 * Common functionality for Telegram, LINE, and other webhook handlers
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================================
// Constants
// ============================================================================

/** Maximum allowed command length to prevent abuse */
const MAX_COMMAND_LENGTH = 10000;

/** Token format: 8 uppercase alphanumeric characters */
const TOKEN_REGEX = /^[A-Z0-9]{8}$/;

/** Session expiry time in milliseconds (24 hours) */
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Rate limiting: commands per session per minute */
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_COMMANDS = 30;

// ============================================================================
// Token Validation
// ============================================================================

/**
 * Validate token format
 * @param {string} token - Token to validate
 * @returns {string|null} Normalized uppercase token or null if invalid
 */
function validateToken(token) {
    if (!token || typeof token !== 'string') return null;
    const upperToken = token.toUpperCase();
    return TOKEN_REGEX.test(upperToken) ? upperToken : null;
}

/**
 * Validate command
 * @param {string} command - Command to validate
 * @returns {{valid: boolean, error?: string, command?: string}}
 */
function validateCommand(command) {
    if (!command || typeof command !== 'string') {
        return { valid: false, error: 'Command must be a non-empty string' };
    }

    const trimmed = command.trim();

    if (trimmed.length === 0) {
        return { valid: false, error: 'Command cannot be empty' };
    }

    if (trimmed.length > MAX_COMMAND_LENGTH) {
        return { valid: false, error: `Command too long: ${trimmed.length} > ${MAX_COMMAND_LENGTH}` };
    }

    return { valid: true, command: trimmed };
}

// ============================================================================
// Callback Data Parsing
// ============================================================================

/**
 * Safely parse callback data
 * Format: prefix:token:data or prefix:token
 * @param {string} data - Callback data string
 * @returns {{prefix: string|null, token: string|null, command: string|null}}
 */
function parseCallbackData(data) {
    if (!data || typeof data !== 'string') {
        return { prefix: null, token: null, command: null };
    }

    const parts = data.split(':');
    const prefix = parts[0] || null;
    const token = parts[1] ? validateToken(parts[1]) : null;
    const command = parts.length > 2 ? parts.slice(2).join(':') : null;

    return { prefix, token, command };
}

// ============================================================================
// Session Management (Async)
// ============================================================================

/**
 * Find session by token (async version for webhook handlers)
 * @param {string} token - Session token
 * @param {string} sessionsDir - Directory containing session files
 * @param {object} logger - Logger instance (optional)
 * @returns {Promise<object|null>} Session object or null if not found
 */
async function findSessionByToken(token, sessionsDir, logger = null) {
    // Validate token format first
    const validToken = validateToken(token);
    if (!validToken) {
        if (logger) logger.warn('Invalid token format in session lookup');
        return null;
    }

    // Check if sessions directory exists
    try {
        await fs.access(sessionsDir);
    } catch (error) {
        if (logger) logger.debug('Sessions directory does not exist');
        return null;
    }

    let files;
    try {
        files = await fs.readdir(sessionsDir);
    } catch (error) {
        if (logger) logger.error('Failed to read sessions directory:', error.message);
        return null;
    }

    for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const sessionPath = path.join(sessionsDir, file);
        try {
            const content = await fs.readFile(sessionPath, 'utf8');
            const session = safeParseJSON(content);
            if (session && session.token === validToken) {
                return session;
            }
        } catch (error) {
            if (logger) logger.error(`Failed to read session file ${file}:`, error.message);
        }
    }

    return null;
}

/**
 * Find session by token (sync version for non-critical paths)
 * @param {string} token - Session token
 * @param {string} sessionsDir - Directory containing session files
 * @param {object} logger - Logger instance (optional)
 * @returns {object|null} Session object or null if not found
 */
function findSessionByTokenSync(token, sessionsDir, logger = null) {
    // Validate token format first
    const validToken = validateToken(token);
    if (!validToken) {
        if (logger) logger.warn('Invalid token format in session lookup');
        return null;
    }

    // Check if sessions directory exists
    if (!fsSync.existsSync(sessionsDir)) {
        if (logger) logger.debug('Sessions directory does not exist');
        return null;
    }

    let files;
    try {
        files = fsSync.readdirSync(sessionsDir);
    } catch (error) {
        if (logger) logger.error('Failed to read sessions directory:', error.message);
        return null;
    }

    for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const sessionPath = path.join(sessionsDir, file);
        try {
            const content = fsSync.readFileSync(sessionPath, 'utf8');
            const session = safeParseJSON(content);
            if (session && session.token === validToken) {
                return session;
            }
        } catch (error) {
            if (logger) logger.error(`Failed to read session file ${file}:`, error.message);
        }
    }

    return null;
}

/**
 * Check if session is expired
 * @param {object} session - Session object
 * @returns {boolean} True if expired
 */
function isSessionExpired(session) {
    if (!session) return true;

    const now = Math.floor(Date.now() / 1000);
    return session.expiresAt < now;
}

/**
 * Remove session file (async)
 * @param {string} sessionId - Session ID
 * @param {string} sessionsDir - Sessions directory
 * @param {object} logger - Logger instance (optional)
 */
async function removeSession(sessionId, sessionsDir, logger = null) {
    const sessionFile = path.join(sessionsDir, `${sessionId}.json`);
    try {
        await fs.access(sessionFile);
        await fs.unlink(sessionFile);
        if (logger) logger.debug(`Session removed: ${sessionId}`);
    } catch (error) {
        // File doesn't exist or other error - that's fine
    }
}

// ============================================================================
// JSON Utilities
// ============================================================================

/**
 * Safely parse JSON with error handling
 * @param {string} content - JSON string
 * @param {*} defaultValue - Default value if parsing fails
 * @returns {*} Parsed object or default value
 */
function safeParseJSON(content, defaultValue = null) {
    try {
        return JSON.parse(content);
    } catch (error) {
        return defaultValue;
    }
}

// ============================================================================
// Signature Verification
// ============================================================================

/**
 * Verify LINE webhook signature
 * @param {Buffer|string} body - Request body
 * @param {string} signature - X-Line-Signature header
 * @param {string} channelSecret - LINE channel secret
 * @returns {boolean} True if valid
 */
function verifyLINESignature(body, signature, channelSecret) {
    if (!channelSecret) return false;

    const hash = crypto
        .createHmac('SHA256', channelSecret)
        .update(body)
        .digest('base64');

    return hash === signature;
}

/**
 * Verify Telegram webhook secret token
 * @param {string} secretToken - X-Telegram-Bot-Api-Secret-Token header
 * @param {string} expectedToken - Expected secret token from config
 * @returns {boolean} True if valid
 */
function verifyTelegramSecret(secretToken, expectedToken) {
    if (!expectedToken) return true; // Not configured, allow all
    if (!secretToken) return false;

    // Use timing-safe comparison to prevent timing attacks
    try {
        return crypto.timingSafeEqual(
            Buffer.from(secretToken),
            Buffer.from(expectedToken)
        );
    } catch (error) {
        return false;
    }
}

// ============================================================================
// Rate Limiting
// ============================================================================

/**
 * Rate limiter class for session-based rate limiting
 */
class RateLimiter {
    constructor(windowMs = RATE_LIMIT_WINDOW_MS, maxCommands = RATE_LIMIT_MAX_COMMANDS) {
        this.windowMs = windowMs;
        this.maxCommands = maxCommands;
        this.sessionMap = new Map();
    }

    /**
     * Check if request is allowed and record it
     * @param {string} sessionKey - Session identifier
     * @returns {boolean} True if allowed
     */
    checkAndRecord(sessionKey) {
        const now = Date.now();
        const windowStart = now - this.windowMs;

        let state = this.sessionMap.get(sessionKey);
        if (!state) {
            state = { timestamps: [] };
            this.sessionMap.set(sessionKey, state);
        }

        // Remove old timestamps
        state.timestamps = state.timestamps.filter(ts => ts > windowStart);

        // Check limit
        if (state.timestamps.length >= this.maxCommands) {
            return false;
        }

        // Record this request
        state.timestamps.push(now);
        return true;
    }

    /**
     * Clear rate limit data for a session
     * @param {string} sessionKey - Session identifier
     */
    clear(sessionKey) {
        this.sessionMap.delete(sessionKey);
    }

    /**
     * Clear all rate limit data
     */
    clearAll() {
        this.sessionMap.clear();
    }
}

// ============================================================================
// AppleScript Utilities
// ============================================================================

/**
 * Escape string for safe use in AppleScript
 * Escapes backslashes, quotes, and control characters
 * @param {string} str - String to escape
 * @returns {string} Escaped string safe for AppleScript
 */
function escapeForAppleScript(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
    // Constants
    MAX_COMMAND_LENGTH,
    TOKEN_REGEX,
    SESSION_EXPIRY_MS,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX_COMMANDS,

    // Token validation
    validateToken,
    validateCommand,

    // Callback parsing
    parseCallbackData,

    // Session management
    findSessionByToken,
    findSessionByTokenSync,
    isSessionExpired,
    removeSession,

    // JSON utilities
    safeParseJSON,

    // Signature verification
    verifyLINESignature,
    verifyTelegramSecret,

    // Rate limiting
    RateLimiter,

    // AppleScript utilities
    escapeForAppleScript
};
