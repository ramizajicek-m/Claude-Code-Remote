/**
 * Telegram Webhook Handler
 * Handles incoming Telegram messages and commands
 */

const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const Logger = require('../../core/logger');
const ControllerInjector = require('../../utils/controller-injector');
const {
    validateToken,
    validateCommand,
    parseCallbackData,
    findSessionByToken,
    isSessionExpired,
    removeSession,
    safeParseJSON,
    verifyTelegramSecret,
    SESSION_EXPIRY_MS
} = require('../../utils/webhook-utils');

class TelegramWebhookHandler {
    constructor(config = {}) {
        this.config = config;
        this.logger = new Logger('TelegramWebhook');
        this.sessionsDir = path.join(__dirname, '../../data/sessions');
        this.injector = new ControllerInjector();
        this.app = express();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.botUsername = null; // Cache for bot username
        this.activeTokenPath = path.join(__dirname, '../../../active-token.json');

        this._setupMiddleware();
        this._setupRoutes();
    }

    _setupMiddleware() {
        // Parse JSON for all requests
        this.app.use(express.json());
    }

    _setupRoutes() {
        // Telegram webhook endpoint
        this.app.post('/webhook/telegram', this._handleWebhook.bind(this));

        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', service: 'telegram-webhook' });
        });
    }

    /**
     * Generate network options for axios requests
     * @returns {Object} Network options object
     */
    _getNetworkOptions() {
        const options = {};
        if (this.config.forceIPv4) {
            options.family = 4;
        }
        return options;
    }

    async _handleWebhook(req, res) {
        try {
            // Verify webhook secret token if configured
            const secretToken = req.headers['x-telegram-bot-api-secret-token'];
            if (!verifyTelegramSecret(secretToken, this.config.webhookSecretToken)) {
                this.logger.warn('Invalid Telegram webhook secret token');
                return res.status(401).send('Unauthorized');
            }

            const update = req.body;

            // Validate update structure
            if (!update || typeof update !== 'object') {
                this.logger.warn('Invalid webhook payload');
                return res.status(400).send('Bad Request');
            }

            // Handle different update types
            if (update.message) {
                await this._handleMessage(update.message);
            } else if (update.callback_query) {
                await this._handleCallbackQuery(update.callback_query);
            }

            res.status(200).send('OK');
        } catch (error) {
            this.logger.error('Webhook handling error:', error.message);
            res.status(500).send('Internal Server Error');
        }
    }

    async _handleMessage(message) {
        const chatId = message.chat.id;
        const userId = message.from.id;
        const messageText = message.text?.trim();

        if (!messageText) {
            return;
        }

        // Check if user is authorized
        if (!this._isAuthorized(userId, chatId)) {
            this.logger.warn(`Unauthorized user/chat: ${userId}/${chatId}`);
            await this._sendMessage(chatId, '⚠️ You are not authorized to use this bot.');
            return;
        }

        // Handle /start command
        if (messageText === '/start') {
            await this._sendWelcomeMessage(chatId);
            return;
        }

        // Handle /help command
        if (messageText === '/help') {
            await this._sendHelpMessage(chatId);
            return;
        }

        // Parse /cmd command
        const commandMatch = messageText.match(/^\/cmd\s+([A-Z0-9]{8})\s+(.+)$/i);
        if (commandMatch) {
            await this._processCommand(chatId, commandMatch[1].toUpperCase(), commandMatch[2]);
            return;
        }

        // Check if it's TOKEN + command format
        const directMatch = messageText.match(/^([A-Z0-9]{8})\s+(.+)$/);
        if (directMatch) {
            await this._processCommand(chatId, directMatch[1].toUpperCase(), directMatch[2]);
            return;
        }

        // Check if replying to a notification message - extract token from buttons
        if (message.reply_to_message && message.reply_to_message.reply_markup) {
            const buttons = message.reply_to_message.reply_markup.inline_keyboard;
            if (buttons && buttons[0] && buttons[0][0]) {
                const callbackData = buttons[0][0].callback_data;
                if (callbackData && callbackData.startsWith('quick:')) {
                    const parsed = parseCallbackData(callbackData);
                    if (parsed.token) {
                        await this._processCommand(chatId, parsed.token, messageText);
                        return;
                    }
                }
            }
        }

        // Try to use active token for direct text input
        const activeToken = await this._getActiveToken();
        if (activeToken) {
            await this._processCommand(chatId, activeToken.token, messageText);
        } else {
            await this._sendMessage(chatId,
                '❌ No active session. Wait for a notification or use:\n`/cmd <TOKEN> <command>`',
                { parse_mode: 'Markdown' });
        }
    }

    async _getActiveToken() {
        try {
            await fs.access(this.activeTokenPath);
            const content = await fs.readFile(this.activeTokenPath, 'utf8');
            const data = safeParseJSON(content);
            // Check if token is recent (within 24 hours)
            if (data && data.updatedAt && (Date.now() - data.updatedAt) < SESSION_EXPIRY_MS) {
                return data;
            }
        } catch (e) {
            // File doesn't exist or can't be read - that's fine
            if (e.code !== 'ENOENT') {
                this.logger.error('Failed to read active token:', e.message);
            }
        }
        return null;
    }

    async _processCommand(chatId, token, command) {
        // Validate token format
        const validToken = validateToken(token);
        if (!validToken) {
            await this._sendMessage(chatId,
                '❌ Invalid token format.',
                { parse_mode: 'Markdown' });
            return;
        }

        // Validate command
        const commandValidation = validateCommand(command);
        if (!commandValidation.valid) {
            await this._sendMessage(chatId,
                `❌ Invalid command: ${commandValidation.error}`,
                { parse_mode: 'Markdown' });
            return;
        }

        // Find session by token
        const session = await findSessionByToken(validToken, this.sessionsDir, this.logger);
        if (!session) {
            await this._sendMessage(chatId,
                '❌ Invalid or expired token. Please wait for a new task notification.',
                { parse_mode: 'Markdown' });
            return;
        }

        // Check if session is expired
        if (isSessionExpired(session)) {
            await this._sendMessage(chatId,
                '❌ Token has expired. Please wait for a new task notification.',
                { parse_mode: 'Markdown' });
            await removeSession(session.id, this.sessionsDir, this.logger);
            return;
        }

        try {
            // Inject command - use token for PTY mode, tmuxSession for tmux mode
            const injectionMode = process.env.INJECTION_MODE || 'pty';
            const sessionRef = injectionMode === 'pty' ? validToken : (session.tmuxSession || 'default');
            await this.injector.injectCommand(commandValidation.command, sessionRef);

            // Log command execution
            this.logger.info(`Command injected - User: ${chatId}, Token: ${validToken}, Command: ${commandValidation.command}`);

        } catch (error) {
            this.logger.error('Command injection failed:', error.message);
            await this._sendMessage(chatId,
                `❌ *Command execution failed:* ${error.message}`,
                { parse_mode: 'Markdown' });
        }
    }

    async _handleCallbackQuery(callbackQuery) {
        const chatId = callbackQuery.message?.chat?.id;
        const data = callbackQuery.data;

        if (!chatId) {
            this.logger.warn('Callback query missing chat ID');
            return;
        }

        // Answer callback query to remove loading state
        await this._answerCallbackQuery(callbackQuery.id);

        // Parse callback data safely
        const parsed = parseCallbackData(data);

        if (!parsed.prefix) {
            this.logger.warn('Invalid callback data format');
            return;
        }

        // Handle quick action buttons: quick:TOKEN:command
        if (parsed.prefix === 'quick') {
            if (!parsed.token) {
                this.logger.warn('Quick action missing valid token');
                return;
            }
            if (parsed.command) {
                await this._processCommand(chatId, parsed.token, parsed.command);
            }
            return;
        }

        // Handle info buttons
        if (parsed.prefix === 'personal' && parsed.token) {
            await this._sendMessage(chatId,
                `📝 Just type your message directly - it will be sent to the active session.\n\nOr use: \`/cmd ${parsed.token} <command>\``,
                { parse_mode: 'Markdown' });
        } else if (parsed.prefix === 'group' && parsed.token) {
            const botUsername = await this._getBotUsername();
            await this._sendMessage(chatId,
                `👥 *Group Chat:*\n\n\`@${botUsername} /cmd ${parsed.token} <command>\``,
                { parse_mode: 'Markdown' });
        } else if (parsed.prefix === 'session' && parsed.token) {
            await this._sendMessage(chatId,
                `📝 Just type your message directly!\n\nOr: \`/cmd ${parsed.token} <command>\``,
                { parse_mode: 'Markdown' });
        }
    }

    async _sendWelcomeMessage(chatId) {
        const message = `🤖 *Welcome to Claude Code Remote Bot!*\n\n` +
            `I'll notify you when Claude completes tasks or needs input.\n\n` +
            `When you receive a notification with a token, you can send commands back using:\n` +
            `\`/cmd <TOKEN> <your command>\`\n\n` +
            `Type /help for more information.`;
        
        await this._sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async _sendHelpMessage(chatId) {
        const message = `📚 *Claude Code Remote Bot Help*\n\n` +
            `*Commands:*\n` +
            `• \`/start\` - Welcome message\n` +
            `• \`/help\` - Show this help\n` +
            `• \`/cmd <TOKEN> <command>\` - Send command to Claude\n\n` +
            `*Example:*\n` +
            `\`/cmd ABC12345 analyze the performance of this function\`\n\n` +
            `*Tips:*\n` +
            `• Tokens are case-insensitive\n` +
            `• Tokens expire after 24 hours\n` +
            `• You can also just type \`TOKEN command\` without /cmd`;
        
        await this._sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    _isAuthorized(userId, chatId) {
        // Check whitelist
        const whitelist = this.config.whitelist || [];
        
        if (whitelist.includes(String(chatId)) || whitelist.includes(String(userId))) {
            return true;
        }
        
        // If no whitelist configured, allow configured chat/user
        if (whitelist.length === 0) {
            const configuredChatId = this.config.chatId || this.config.groupId;
            if (configuredChatId && String(chatId) === String(configuredChatId)) {
                return true;
            }
        }
        
        return false;
    }

    async _getBotUsername() {
        if (this.botUsername) {
            return this.botUsername;
        }

        try {
            const response = await axios.get(
                `${this.apiBaseUrl}/bot${this.config.botToken}/getMe`,
                this._getNetworkOptions()
            );
            
            if (response.data.ok && response.data.result.username) {
                this.botUsername = response.data.result.username;
                return this.botUsername;
            }
        } catch (error) {
            this.logger.error('Failed to get bot username:', error.message);
        }
        
        // Fallback to configured username or default
        return this.config.botUsername || 'claude_remote_bot';
    }

    async _sendMessage(chatId, text, options = {}) {
        try {
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                {
                    chat_id: chatId,
                    text: text,
                    ...options
                },
                this._getNetworkOptions()
            );
        } catch (error) {
            this.logger.error('Failed to send message:', error.response?.data || error.message);
        }
    }

    async _answerCallbackQuery(callbackQueryId, text = '') {
        try {
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/answerCallbackQuery`,
                {
                    callback_query_id: callbackQueryId,
                    text: text
                },
                this._getNetworkOptions()
            );
        } catch (error) {
            this.logger.error('Failed to answer callback query:', error.response?.data || error.message);
        }
    }

    async setWebhook(webhookUrl) {
        try {
            const webhookConfig = {
                url: webhookUrl,
                allowed_updates: ['message', 'callback_query']
            };

            // Add secret token if configured
            if (this.config.webhookSecretToken) {
                webhookConfig.secret_token = this.config.webhookSecretToken;
            }

            const response = await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/setWebhook`,
                webhookConfig,
                this._getNetworkOptions()
            );

            this.logger.info('Webhook set successfully:', response.data);
            return response.data;
        } catch (error) {
            this.logger.error('Failed to set webhook:', error.response?.data || error.message);
            throw error;
        }
    }

    start(port = 3000) {
        this.app.listen(port, () => {
            this.logger.info(`Telegram webhook server started on port ${port}`);
        });
    }
}

module.exports = TelegramWebhookHandler;
