#!/usr/bin/env node
/**
 * Claude Hook Notify with PTY tracking
 * Captures the current terminal's PTY for direct command injection
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Debug logging
const DEBUG_LOG = '/tmp/claude-hook-debug.log';
fs.appendFileSync(DEBUG_LOG, `\n[${new Date().toISOString()}] Hook called\n`);

// Check if Telegram notifications are enabled for this session
if (!process.env.CLAUDE_TELEGRAM) {
    fs.appendFileSync(DEBUG_LOG, `Skipping: CLAUDE_TELEGRAM not set\n`);
    process.exit(0);
}

// Load environment
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
}

// Read stdin (hook input from Claude)
async function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('readable', () => {
            let chunk;
            while ((chunk = process.stdin.read()) !== null) {
                data += chunk;
            }
        });
        process.stdin.on('end', () => {
            resolve(data);
        });
        // Timeout after 100ms if no input
        setTimeout(() => resolve(data), 100);
    });
}

const SESSION_MAP_PATH = process.env.SESSION_MAP_PATH || path.join(__dirname, 'session-map.json');

// Get current TTY by checking parent process
function getCurrentTTY() {
    try {
        // Method 1: Try to get TTY from parent shell process
        const ppid = process.ppid;
        const psOutput = execSync(`ps -p ${ppid} -o tty=`, { encoding: 'utf8' }).trim();
        if (psOutput && psOutput !== '??' && psOutput !== '-') {
            const tty = psOutput.startsWith('/dev/') ? psOutput : `/dev/${psOutput}`;
            if (fs.existsSync(tty)) {
                return tty;
            }
        }
    } catch (e) {}

    try {
        // Method 2: Walk up the process tree
        let pid = process.ppid;
        for (let i = 0; i < 5; i++) {
            const psOutput = execSync(`ps -p ${pid} -o ppid=,tty=`, { encoding: 'utf8' }).trim();
            const parts = psOutput.split(/\s+/);
            if (parts.length >= 2) {
                const ttyPart = parts[1];
                if (ttyPart && ttyPart !== '??' && ttyPart !== '-') {
                    const tty = ttyPart.startsWith('/dev/') ? ttyPart : `/dev/${ttyPart}`;
                    if (fs.existsSync(tty)) {
                        return tty;
                    }
                }
                pid = parseInt(parts[0]);
                if (pid <= 1) break;
            } else {
                break;
            }
        }
    } catch (e) {}

    try {
        // Method 3: Find any active ttys terminal
        const ttyOutput = execSync('ls /dev/ttys* 2>/dev/null | head -5', { encoding: 'utf8' }).trim();
        const ttys = ttyOutput.split('\n').filter(t => t);
        // Find a writable TTY
        for (const tty of ttys) {
            try {
                fs.accessSync(tty, fs.constants.W_OK);
                return tty;
            } catch (e) {}
        }
    } catch (e) {}

    return null;
}

// Generate 8-char token
function generateToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let token = '';
    for (let i = 0; i < 8; i++) {
        token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
}

// Load or create session map
function loadSessionMap() {
    if (fs.existsSync(SESSION_MAP_PATH)) {
        return JSON.parse(fs.readFileSync(SESSION_MAP_PATH, 'utf8'));
    }
    return {};
}

// Save session map (cleanup sessions with dead TTYs)
function saveSessionMap(map) {
    for (const token of Object.keys(map)) {
        const ptyPath = map[token].ptyPath;
        // Remove if no PTY or PTY no longer exists
        if (!ptyPath || !fs.existsSync(ptyPath)) {
            delete map[token];
        }
    }
    fs.writeFileSync(SESSION_MAP_PATH, JSON.stringify(map, null, 2));
}

// Main
async function main() {
    // Read hook input from stdin
    const stdinData = await readStdin();
    let hookInput = {};
    let lastMessage = '';
    let stopReason = 'completed';

    try {
        if (stdinData.trim()) {
            hookInput = JSON.parse(stdinData);
            fs.appendFileSync(DEBUG_LOG, `Hook input: ${JSON.stringify(hookInput, null, 2)}\n`);

            // Only notify on actual Stop events, not SubagentStop
            if (hookInput.hook_event_name === 'SubagentStop') {
                fs.appendFileSync(DEBUG_LOG, `Skipping SubagentStop notification\n`);
                return;
            }

            // Read transcript from file if path is provided
            if (hookInput.transcript_path && fs.existsSync(hookInput.transcript_path)) {
                try {
                    const transcriptData = fs.readFileSync(hookInput.transcript_path, 'utf8');
                    const lines = transcriptData.trim().split('\n');

                    // Parse JSONL - find last assistant message
                    for (let i = lines.length - 1; i >= 0; i--) {
                        try {
                            const entry = JSON.parse(lines[i]);
                            if (entry.type === 'assistant' && entry.message && entry.message.content) {
                                const content = entry.message.content;
                                if (Array.isArray(content)) {
                                    lastMessage = content
                                        .filter(c => c.type === 'text')
                                        .map(c => c.text)
                                        .join('\n');
                                } else {
                                    lastMessage = content;
                                }
                                if (entry.message.stop_reason) {
                                    stopReason = entry.message.stop_reason;
                                }
                                break;
                            }
                        } catch (lineErr) {}
                    }
                } catch (readErr) {
                    fs.appendFileSync(DEBUG_LOG, `Transcript read error: ${readErr.message}\n`);
                }
            }

            // Get stop reason from hook input if available
            if (hookInput.stop_reason) {
                stopReason = hookInput.stop_reason;
            }
        }
    } catch (e) {
        fs.appendFileSync(DEBUG_LOG, `Parse error: ${e.message}\n`);
    }

    const tty = getCurrentTTY();
    const tmuxSession = process.env.CLAUDE_TMUX_SESSION;
    const token = generateToken();
    const cwd = process.cwd();
    const project = path.basename(cwd);

    console.log(`🔔 Claude Hook: ${stopReason}`);
    console.log(`📁 Project: ${project}`);
    if (tmuxSession) {
        console.log(`🖥️  Tmux: ${tmuxSession}`);
    } else {
        console.log(`🖥️  TTY: ${tty || 'not detected'}`);
    }
    console.log(`🔑 Token: ${token}`);

    if (!tty && !tmuxSession) {
        console.log('⚠️  Warning: Could not detect TTY or tmux. Remote commands may not work.');
    }

    // Save to session map - prefer tmux if available
    const sessionMap = loadSessionMap();
    sessionMap[token] = {
        type: tmuxSession ? 'tmux' : 'pty',
        tmuxSession: tmuxSession || null,
        ptyPath: tty,
        cwd: cwd,
        project: project,
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 86400 // 24 hours
    };
    saveSessionMap(sessionMap);
    console.log(`💾 Session saved to: ${SESSION_MAP_PATH}`);

    // Also create session file for webhook compatibility
    const sessionsDir = path.join(__dirname, 'src/data/sessions');
    if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
    }

    const sessionId = require('crypto').randomUUID();
    const sessionFile = path.join(sessionsDir, `${sessionId}.json`);
    fs.writeFileSync(sessionFile, JSON.stringify({
        id: sessionId,
        token: token,
        type: 'telegram',
        created: new Date().toISOString(),
        expires: new Date(Date.now() + 86400000).toISOString(),
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        ptyPath: tty,
        project: project,
        notification: {
            type: stopReason,
            project: project
        }
    }, null, 2));

    // Send Telegram notification
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (botToken && chatId) {
        const axios = require('axios');
        const emoji = stopReason === 'end_turn' ? '✅' : '⏳';
        const status = stopReason === 'end_turn' ? 'Completed' : 'Waiting for Input';

        // Save as active token for direct replies
        const activeTokenPath = path.join(__dirname, 'active-token.json');
        fs.writeFileSync(activeTokenPath, JSON.stringify({
            token: token,
            project: project,
            type: tmuxSession ? 'tmux' : 'pty',
            tmuxSession: tmuxSession || null,
            ptyPath: tty,
            updatedAt: Date.now()
        }));

        // Truncate last message for Telegram (max ~500 chars) - show END of message
        let msgPreview = lastMessage.trim();
        if (msgPreview.length > 500) {
            msgPreview = '...' + msgPreview.substring(msgPreview.length - 500);
        }

        const ttyShort = tty ? tty.replace('/dev/ttys', 's') : '?';
        const message = msgPreview
            ? `${emoji} *${project}* (${ttyShort})\n\n${msgPreview}`
            : `${emoji} *${project}* (${ttyShort}) - ${status}`;

        // Quick action buttons
        const buttons = stopReason === 'end_turn'
            ? [
                [
                    { text: '📖', callback_data: `quick:${token}:explain what you did` }
                ]
            ]
            : [
                [
                    { text: '1️⃣', callback_data: `quick:${token}:1` },
                    { text: '2️⃣', callback_data: `quick:${token}:2` },
                    { text: '3️⃣', callback_data: `quick:${token}:3` },
                    { text: '✅', callback_data: `quick:${token}:yes` },
                    { text: '❌', callback_data: `quick:${token}:no` }
                ]
            ];

        try {
            await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
            console.log(`✅ Telegram notification sent!`);
        } catch (err) {
            console.error(`❌ Telegram error: ${err.message}`);
        }
    } else {
        console.log('⚠️  Telegram not configured');
    }
}

main().catch(console.error);
