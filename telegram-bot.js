#!/usr/bin/env node
/**
 * Claude Code Remote - Telegram Bot (Long Polling)
 * No ngrok required - polls Telegram directly
 * Security-hardened version using execFileSync
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
    validateToken,
    validateCommand,
    parseCallbackData,
    safeParseJSON,
    escapeForAppleScript,
    SESSION_EXPIRY_MS
} = require('./src/utils/webhook-utils');

/**
 * Validate required environment variables at startup
 */
function validateEnv() {
    const required = [
        { name: 'TELEGRAM_BOT_TOKEN', description: 'Telegram bot token from @BotFather' },
        { name: 'TELEGRAM_CHAT_ID', description: 'Your Telegram chat ID' }
    ];

    const missing = [];
    const invalid = [];

    for (const { name, description } of required) {
        const value = process.env[name];
        if (!value) {
            missing.push(`  - ${name}: ${description}`);
        } else if (name === 'TELEGRAM_BOT_TOKEN' && !value.includes(':')) {
            invalid.push(`  - ${name}: Invalid format (should contain ':')`);
        } else if (name === 'TELEGRAM_CHAT_ID' && !/^-?\d+$/.test(value)) {
            invalid.push(`  - ${name}: Invalid format (should be a number)`);
        }
    }

    if (missing.length > 0 || invalid.length > 0) {
        console.error('\n❌ Configuration Error:\n');

        if (missing.length > 0) {
            console.error('Missing required environment variables:');
            console.error(missing.join('\n'));
        }

        if (invalid.length > 0) {
            console.error('\nInvalid environment variables:');
            console.error(invalid.join('\n'));
        }

        console.error('\n📝 Create a .env file with these variables, or run: npm run setup\n');
        process.exit(1);
    }
}

// Validate environment before proceeding
validateEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

let lastUpdateId = 0;

// Session map path
const SESSION_MAP_PATH = path.join(__dirname, 'session-map.json');
const ACTIVE_TOKEN_PATH = path.join(__dirname, 'active-token.json');
const CLAUDE_COMMANDS_DIR = path.join(process.env.HOME, '.claude/commands');

// Load skills dynamically from Claude Code's commands directory
function loadClaudeSkills() {
    const skills = [];
    try {
        if (fs.existsSync(CLAUDE_COMMANDS_DIR)) {
            const files = fs.readdirSync(CLAUDE_COMMANDS_DIR);
            for (const file of files) {
                if (!file.endsWith('.md')) continue;

                const skillName = file.replace('.md', '');
                const filePath = path.join(CLAUDE_COMMANDS_DIR, file);

                // Read first line for description
                let description = skillName;
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const firstLine = content.split('\n')[0].replace(/^#\s*/, '').trim();
                    if (firstLine) description = firstLine.substring(0, 50);
                } catch (e) {}

                // Telegram commands can't have hyphens, convert to underscore
                const telegramCmd = skillName.replace(/-/g, '_');

                skills.push({
                    command: telegramCmd,
                    description: description,
                    send: `/${skillName}`
                });
            }
            log(`Loaded ${skills.length} skills from ${CLAUDE_COMMANDS_DIR}`);
        }
    } catch (err) {
        log(`Failed to load Claude skills: ${err.message}`);
    }
    return skills;
}

let customCommands = loadClaudeSkills();

async function registerCommands() {
    try {
        const defaultCommands = [
            { command: 'start', description: 'Start the bot' },
            { command: 'help', description: 'Show help' },
            { command: 'reload', description: 'Refresh skills' },
            { command: 'cmd', description: 'Send command: /cmd TOKEN message' }
        ];

        const skillCommands = customCommands.map(c => ({
            command: c.command,
            description: c.description
        }));

        await axios.post(`${API_URL}/setMyCommands`, {
            commands: [...defaultCommands, ...skillCommands]
        });

        log(`Bot commands registered (${defaultCommands.length + skillCommands.length} total)`);
    } catch (err) {
        log(`Failed to register commands: ${err.message}`);
    }
}

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function loadSessionMap() {
    if (fs.existsSync(SESSION_MAP_PATH)) {
        const content = fs.readFileSync(SESSION_MAP_PATH, 'utf8');
        return safeParseJSON(content, {});
    }
    return {};
}

function getActiveToken() {
    try {
        if (fs.existsSync(ACTIVE_TOKEN_PATH)) {
            const content = fs.readFileSync(ACTIVE_TOKEN_PATH, 'utf8');
            const data = safeParseJSON(content);
            if (data && data.updatedAt && (Date.now() - data.updatedAt) < SESSION_EXPIRY_MS) {
                return data;
            }
        }
    } catch (e) {
        log(`Error reading active token: ${e.message}`);
    }
    return null;
}

async function sendMessage(chatId, text, options = {}) {
    try {
        await axios.post(`${API_URL}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown',
            ...options
        });
    } catch (err) {
        log(`Error sending message: ${err.message}`);
    }
}

async function answerCallbackQuery(callbackQueryId) {
    try {
        await axios.post(`${API_URL}/answerCallbackQuery`, {
            callback_query_id: callbackQueryId
        });
    } catch (err) {}
}

function injectCommand(token, command) {
    const sessionMap = loadSessionMap();
    const session = sessionMap[token];

    if (!session) {
        throw new Error(`Session not found: ${token}`);
    }

    // Use tmux if available (works with lid closed)
    if (session.type === 'tmux' && session.tmuxSession) {
        return injectViaTmux(session.tmuxSession, command);
    }

    // Fallback to PTY/AppleScript (only works with lid open)
    if (!session.ptyPath) {
        throw new Error(`No tmux or PTY available for session: ${token}`);
    }

    return injectViaAppleScript(session.ptyPath, command);
}

/**
 * Sanitize session name to prevent command injection
 * Only allows alphanumeric, dash, underscore
 */
function sanitizeSessionName(name) {
    if (!name || typeof name !== 'string') {
        throw new Error('Invalid session name');
    }
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sanitized) {
        throw new Error('Session name contains no valid characters');
    }
    return sanitized;
}

function injectViaTmux(sessionName, command) {
    // Sanitize session name
    const sanitizedSession = sanitizeSessionName(sessionName);

    // Check if tmux session exists using execFileSync (safe)
    try {
        execFileSync('tmux', ['has-session', '-t', sanitizedSession], {
            stdio: 'ignore',
            timeout: 5000
        });
    } catch (e) {
        throw new Error(`Tmux session not found: ${sanitizedSession}`);
    }

    // Clear current input using execFileSync (safe)
    execFileSync('tmux', ['send-keys', '-t', sanitizedSession, 'C-u'], {
        timeout: 2000
    });

    // Send command as a single argument (safe, no shell interpolation)
    execFileSync('tmux', ['send-keys', '-t', sanitizedSession, command], {
        timeout: 2000
    });

    // Press Enter
    execFileSync('tmux', ['send-keys', '-t', sanitizedSession, 'C-m'], {
        timeout: 2000
    });

    log(`Tmux inject to ${sanitizedSession}: ${command}`);
    return true;
}

function injectViaAppleScript(ptyPath, command) {
    const ttyName = ptyPath.replace('/dev/', '');
    const escapedCommand = escapeForAppleScript(command);
    const escapedTtyName = escapeForAppleScript(ttyName);

    const script = `
        tell application "iTerm2"
            activate
            delay 0.1
            repeat with aWindow in windows
                repeat with aTab in tabs of aWindow
                    repeat with aSession in sessions of aTab
                        if tty of aSession contains "${escapedTtyName}" then
                            tell aSession
                                select
                                write text "${escapedCommand}"
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

    if (result !== 'sent') {
        throw new Error(`iTerm2 session not found: ${ttyName}`);
    }

    log(`AppleScript inject to ${ptyPath}: ${command}`);
    return true;
}

async function processCommand(chatId, token, command) {
    // Validate token format
    const validToken = validateToken(token);
    if (!validToken) {
        await sendMessage(chatId, '❌ Invalid token format.');
        return;
    }

    // Validate command
    const commandValidation = validateCommand(command);
    if (!commandValidation.valid) {
        await sendMessage(chatId, `❌ Invalid command: ${commandValidation.error}`);
        return;
    }

    try {
        injectCommand(validToken, commandValidation.command);
        log(`Command sent - Token: ${validToken}, Command: ${commandValidation.command}`);
    } catch (err) {
        await sendMessage(chatId, `❌ Failed: ${err.message}`);
        log(`Error: ${err.message}`);
    }
}

async function handleMessage(message) {
    const chatId = message.chat.id;
    const text = message.text?.trim();

    if (!text) return;

    // Check authorization
    if (chatId.toString() !== CHAT_ID) {
        log(`Unauthorized: ${chatId}`);
        return;
    }

    // /start or /help
    if (text === '/start' || text === '/help') {
        await sendMessage(chatId,
            `🤖 *Claude Code Remote*\n\n` +
            `• Just type to reply to active session\n` +
            `• Swipe-reply to respond to specific session\n` +
            `• Use buttons on notifications\n` +
            `• /reload to refresh skills`
        );
        return;
    }

    // /reload - refresh skills from Claude commands
    if (text === '/reload') {
        customCommands = loadClaudeSkills();
        await registerCommands();
        await sendMessage(chatId, `✅ Reloaded ${customCommands.length} skills`);
        return;
    }

    // Custom skill commands - forward to Claude
    const customCmd = customCommands.find(c => text === `/${c.command}`);
    if (customCmd) {
        const activeToken = getActiveToken();
        if (activeToken) {
            await processCommand(chatId, activeToken.token, customCmd.send);
        } else {
            await sendMessage(chatId, `❌ No active session. Wait for a notification.`);
        }
        return;
    }

    // /cmd TOKEN message
    const cmdMatch = text.match(/^\/cmd\s+([A-Z0-9]{8})\s+(.+)$/i);
    if (cmdMatch) {
        await processCommand(chatId, cmdMatch[1].toUpperCase(), cmdMatch[2]);
        return;
    }

    // TOKEN message
    const tokenMatch = text.match(/^([A-Z0-9]{8})\s+(.+)$/);
    if (tokenMatch) {
        await processCommand(chatId, tokenMatch[1].toUpperCase(), tokenMatch[2]);
        return;
    }

    // Reply to notification - extract token from buttons
    if (message.reply_to_message?.reply_markup?.inline_keyboard) {
        const buttons = message.reply_to_message.reply_markup.inline_keyboard;
        const callbackData = buttons[0]?.[0]?.callback_data;
        if (callbackData) {
            const parsed = parseCallbackData(callbackData);
            if (parsed.prefix === 'quick' && parsed.token) {
                await processCommand(chatId, parsed.token, text);
                return;
            }
        }
    }

    // Use active token
    const activeToken = getActiveToken();
    if (activeToken) {
        await processCommand(chatId, activeToken.token, text);
    } else {
        await sendMessage(chatId, `❌ No active session. Wait for a notification.`);
    }
}

async function handleCallbackQuery(callbackQuery) {
    const chatId = callbackQuery.message?.chat?.id;
    const data = callbackQuery.data;

    if (!chatId) {
        log('Callback query missing chat ID');
        return;
    }

    await answerCallbackQuery(callbackQuery.id);

    // Parse callback data safely using shared utility
    const parsed = parseCallbackData(data);

    // quick:TOKEN:command
    if (parsed.prefix === 'quick' && parsed.token && parsed.command) {
        await processCommand(chatId, parsed.token, parsed.command);
    }
}

async function poll() {
    try {
        const response = await axios.get(`${API_URL}/getUpdates`, {
            params: {
                offset: lastUpdateId + 1,
                timeout: 30
            },
            timeout: 35000
        });

        const updates = response.data.result;

        for (const update of updates) {
            lastUpdateId = update.update_id;

            if (update.message) {
                await handleMessage(update.message);
            } else if (update.callback_query) {
                await handleCallbackQuery(update.callback_query);
            }
        }
    } catch (err) {
        if (err.code !== 'ECONNABORTED') {
            log(`Poll error: ${err.message}`);
        }
    }

    // Continue polling
    setImmediate(poll);
}

async function start() {
    log('Starting Claude Code Remote Bot (polling mode)...');

    // Delete any existing webhook
    try {
        await axios.post(`${API_URL}/deleteWebhook`);
        log('Webhook deleted, using long polling');
    } catch (err) {}

    await registerCommands();

    // Start polling
    poll();
    log('Bot ready! Waiting for messages...');
}

start().catch(console.error);
