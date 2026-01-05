#!/usr/bin/env node

/**
 * Smart Command Injector - Multiple methods to ensure commands reach Claude Code
 * Security-hardened version using execFile instead of shell string interpolation
 */

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const {
    validateToken,
    validateCommand,
    escapeForAppleScript,
    MAX_COMMAND_LENGTH
} = require('../utils/webhook-utils');

const execFileAsync = promisify(execFile);

// Cleanup interval: 15 minutes
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

// Maximum file age for cleanup: 1 hour
const MAX_FILE_AGE_MS = 60 * 60 * 1000;

class SmartInjector {
    constructor(logger) {
        this.log = logger || console;
        this.tempDir = path.join(__dirname, '../temp');
        this.ensureTempDir();

        // Schedule periodic cleanup
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, CLEANUP_INTERVAL_MS);

        // Unref to allow process to exit naturally
        if (this.cleanupInterval.unref) {
            this.cleanupInterval.unref();
        }
    }

    /**
     * Stop the cleanup interval (call when shutting down)
     */
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    ensureTempDir() {
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true, mode: 0o700 });
        }
    }

    async injectCommand(token, command) {
        // Validate token
        if (!validateToken(token)) {
            this.log.error('Invalid token format');
            return false;
        }

        // Validate command
        const validation = validateCommand(command);
        if (!validation.valid) {
            this.log.error(`Invalid command: ${validation.error}`);
            return false;
        }

        const validatedCommand = validation.command;
        this.log.info(`Smart command injection: ${validatedCommand.slice(0, 50)}...`);

        const methods = [
            this.tryAppleScriptInjection.bind(this),
            this.tryFileDropInjection.bind(this),
            this.tryClipboardWithPersistentNotification.bind(this),
            this.tryUrgentClipboard.bind(this)
        ];

        const methodNames = [
            'AppleScript Auto-injection',
            'File Drag Injection',
            'Persistent Notification Injection',
            'Emergency Clipboard'
        ];

        for (let i = 0; i < methods.length; i++) {
            try {
                this.log.info(`Trying method ${i + 1}: ${methodNames[i]}`);
                const result = await methods[i](token, validatedCommand);

                if (result.success) {
                    this.log.info(`${methodNames[i]} successful: ${result.message}`);
                    return true;
                } else {
                    this.log.warn(`${methodNames[i]} failed: ${result.error}`);
                }
            } catch (error) {
                this.log.error(`${methodNames[i]} exception: ${error.message}`);
            }
        }

        this.log.error('All injection methods failed');
        return false;
    }

    /**
     * Execute AppleScript safely using osascript with -e flag
     * Uses execFile to avoid shell interpolation vulnerabilities
     */
    async _executeAppleScript(script) {
        try {
            const { stdout } = await execFileAsync('osascript', ['-e', script], {
                timeout: 10000,
                maxBuffer: 1024 * 1024
            });
            return { success: true, output: stdout.trim() };
        } catch (error) {
            // Check for permission errors
            if (error.message && (error.message.includes('1002') || error.message.includes('not allowed'))) {
                return { success: false, error: 'permission_denied' };
            }
            return { success: false, error: error.message };
        }
    }

    /**
     * Display a notification using osascript
     */
    async _displayNotification(message, title, subtitle = '', sound = 'Glass') {
        const escapedMessage = escapeForAppleScript(message);
        const escapedTitle = escapeForAppleScript(title);
        const escapedSubtitle = escapeForAppleScript(subtitle);

        const script = `display notification "${escapedMessage}" with title "${escapedTitle}" subtitle "${escapedSubtitle}" sound name "${sound}"`;

        return this._executeAppleScript(script);
    }

    // Method 1: AppleScript Auto-injection
    async tryAppleScriptInjection(token, command) {
        // First copy to clipboard
        await this.copyToClipboard(command);

        const script = `
            tell application "System Events"
                set targetApps to {"Claude", "Claude Code", "Terminal", "iTerm2", "iTerm"}
                set targetApp to null

                repeat with appName in targetApps
                    try
                        if application process appName exists then
                            set targetApp to application process appName
                            exit repeat
                        end if
                    end try
                end repeat

                if targetApp is not null then
                    set frontmost of targetApp to true
                    delay 0.5
                    keystroke "v" using command down
                    delay 0.3
                    keystroke return
                    return "success"
                else
                    return "no_target"
                end if
            end tell
        `;

        const result = await this._executeAppleScript(script);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        if (result.output === 'success') {
            return { success: true, message: 'Auto-paste successful' };
        } else {
            return { success: false, error: result.output };
        }
    }

    // Method 2: File Drag Injection
    async tryFileDropInjection(token, command) {
        try {
            // Token already validated, safe to use in filename
            const fileName = `taskping-command-${token}.txt`;
            const filePath = path.join(this.tempDir, fileName);

            // Validate file path doesn't escape temp directory
            const resolvedPath = path.resolve(filePath);
            if (!resolvedPath.startsWith(path.resolve(this.tempDir))) {
                return { success: false, error: 'Invalid file path' };
            }

            // Write command to file with secure permissions
            await fsp.writeFile(filePath, command, { mode: 0o600 });

            // Copy file path to clipboard
            await this.copyToClipboard(filePath);

            // Display notification
            await this._displayNotification(
                'Command file created and path copied to clipboard!',
                'TaskPing File Injection',
                `Drag file: ${fileName}`,
                'Glass'
            );

            // Open temp directory using execFile (safe)
            await execFileAsync('open', [this.tempDir]);

            return { success: true, message: 'File created, notification sent' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Method 3: Persistent Notification Injection
    async tryClipboardWithPersistentNotification(token, command) {
        try {
            await this.copyToClipboard(command);

            // Safe preview of command (no special chars)
            const safePreview = command.slice(0, 30).replace(/[^\w\s]/g, '');

            // Send multiple notifications to ensure user sees them
            const notifications = [
                { delay: 0, sound: 'Basso', title: 'TaskPing Reminder 1/3', message: 'Command copied! Please paste to Claude Code (Cmd+V)' },
                { delay: 3000, sound: 'Ping', title: 'TaskPing Reminder 2/3', message: 'Reminder: Command still in clipboard' },
                { delay: 8000, sound: 'Purr', title: 'TaskPing Reminder 3/3', message: 'Final reminder: Press Cmd+V in Claude Code' }
            ];

            // Send notifications with delays
            for (const notif of notifications) {
                if (notif.delay > 0) {
                    await new Promise(resolve => setTimeout(resolve, notif.delay));
                }
                await this._displayNotification(
                    notif.message,
                    notif.title,
                    `${safePreview}...`,
                    notif.sound
                );
            }

            return { success: true, message: 'Persistent notification sequence completed' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Method 4: Emergency Clipboard (last resort)
    async tryUrgentClipboard(token, command) {
        try {
            await this.copyToClipboard(command);

            // Create desktop shortcut file
            const desktopPath = path.join(require('os').homedir(), 'Desktop');

            // Write command to a separate file (safe, no shell escaping needed)
            const commandFileName = `taskping-cmd-${token}.txt`;
            const commandFilePath = path.join(this.tempDir, commandFileName);

            // Validate paths don't escape directories
            const resolvedCommandPath = path.resolve(commandFilePath);
            if (!resolvedCommandPath.startsWith(path.resolve(this.tempDir))) {
                return { success: false, error: 'Invalid command file path' };
            }

            // Write command to temp file with secure permissions
            await fsp.writeFile(commandFilePath, command, { mode: 0o600 });

            // Shell script reads from file instead of interpolating command
            // Using cat with the file path is safe since we control the path
            const shortcutContent = `#!/bin/bash
# TaskPing Emergency Command Script
# Token: ${token}
echo "TaskPing Command:"
cat "${commandFilePath}"
echo ""
echo "Copied to clipboard, please press Cmd+V in Claude Code to paste"
cat "${commandFilePath}" | pbcopy
echo "Command refreshed to clipboard"
`;

            // Token is validated (alphanumeric only), safe for filename
            const shortcutPath = path.join(desktopPath, `TaskPing-${token}.command`);

            // Validate shortcut path
            const resolvedShortcutPath = path.resolve(shortcutPath);
            if (!resolvedShortcutPath.startsWith(path.resolve(desktopPath))) {
                return { success: false, error: 'Invalid shortcut path' };
            }

            // Write and set executable with secure permissions
            await fsp.writeFile(shortcutPath, shortcutContent, { mode: 0o700 });

            // Safe preview (no special chars)
            const safePreview = command.slice(0, 20).replace(/[^\w\s]/g, '');

            await this._displayNotification(
                `Emergency Mode: Desktop shortcut file TaskPing-${token}.command created. Double-click to re-copy command to clipboard`,
                'TaskPing Emergency Mode',
                `${safePreview}...`,
                'Sosumi'
            );

            return { success: true, message: 'Emergency mode: Desktop shortcut file created' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Copy text to clipboard using pbcopy
     * Uses spawn to safely pipe text without shell interpolation
     */
    async copyToClipboard(text) {
        return new Promise((resolve, reject) => {
            const pbcopy = spawn('pbcopy');

            pbcopy.stdin.write(text);
            pbcopy.stdin.end();

            pbcopy.on('error', (error) => {
                reject(new Error(`pbcopy failed: ${error.message}`));
            });

            pbcopy.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`pbcopy exited with code ${code}`));
                }
            });
        });
    }

    /**
     * Clean up temporary files older than MAX_FILE_AGE_MS
     */
    async cleanup() {
        try {
            if (!fs.existsSync(this.tempDir)) return;

            const files = await fsp.readdir(this.tempDir);
            const now = Date.now();

            for (const file of files) {
                const filePath = path.join(this.tempDir, file);
                try {
                    const stats = await fsp.stat(filePath);
                    const age = now - stats.mtime.getTime();

                    // Delete temporary files older than 1 hour
                    if (age > MAX_FILE_AGE_MS) {
                        await fsp.unlink(filePath);
                        this.log.info(`Cleaned up old file: ${file}`);
                    }
                } catch (error) {
                    // Ignore individual file errors
                }
            }
        } catch (error) {
            this.log.warn(`Failed to clean up temporary files: ${error.message}`);
        }
    }
}

module.exports = SmartInjector;
