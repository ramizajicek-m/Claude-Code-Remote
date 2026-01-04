#!/usr/bin/env node
/**
 * Claude Code Remote - Telegram Bot (Long Polling)
 * No ngrok required - polls Telegram directly
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
        return JSON.parse(fs.readFileSync(SESSION_MAP_PATH, 'utf8'));
    }
    return {};
}

function getActiveToken() {
    try {
        if (fs.existsSync(ACTIVE_TOKEN_PATH)) {
            const data = JSON.parse(fs.readFileSync(ACTIVE_TOKEN_PATH, 'utf8'));
            if (data.updatedAt && (Date.now() - data.updatedAt) < 86400000) {
                return data;
            }
        }
    } catch (e) {}
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

function injectViaTmux(sessionName, command) {
    const escapedCommand = command.replace(/'/g, "'\"'\"'");

    // Check if tmux session exists
    try {
        execSync(`tmux has-session -t '${sessionName}' 2>/dev/null`, { encoding: 'utf8' });
    } catch (e) {
        throw new Error(`Tmux session not found: ${sessionName}`);
    }

    // Clear current input, send command, press Enter
    execSync(`tmux send-keys -t '${sessionName}' C-u`, { encoding: 'utf8', timeout: 2000 });
    execSync(`tmux send-keys -t '${sessionName}' '${escapedCommand}'`, { encoding: 'utf8', timeout: 2000 });
    execSync(`tmux send-keys -t '${sessionName}' C-m`, { encoding: 'utf8', timeout: 2000 });

    log(`Tmux inject to ${sessionName}: ${command}`);
    return true;
}

function injectViaAppleScript(ptyPath, command) {
    const ttyName = ptyPath.replace('/dev/', '');
    const escapedCommand = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script = `
        tell application "iTerm2"
            activate
            delay 0.1
            repeat with aWindow in windows
                repeat with aTab in tabs of aWindow
                    repeat with aSession in sessions of aTab
                        if tty of aSession contains "${ttyName}" then
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

    const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
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
    try {
        injectCommand(token, command);
        log(`Command sent - Token: ${token}, Command: ${command}`);
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
        if (buttons[0]?.[0]?.callback_data?.startsWith('quick:')) {
            const token = buttons[0][0].callback_data.split(':')[1];
            await processCommand(chatId, token, text);
            return;
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
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    await answerCallbackQuery(callbackQuery.id);

    // quick:TOKEN:command
    if (data.startsWith('quick:')) {
        const parts = data.split(':');
        const token = parts[1];
        const command = parts.slice(2).join(':');
        await processCommand(chatId, token, command);
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
