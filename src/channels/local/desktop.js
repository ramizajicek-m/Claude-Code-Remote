/**
 * Desktop Notification Channel
 * Sends notifications to the local desktop
 */

const NotificationChannel = require('../base/channel');
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const { escapeForAppleScript } = require('../../utils/shared');

class DesktopChannel extends NotificationChannel {
    constructor(config = {}) {
        super('desktop', config);
        this.platform = process.platform;
        this.soundsDir = path.join(__dirname, '../../assets/sounds');
    }

    async _sendImpl(notification) {
        const { title, message } = notification;
        const sound = this._getSoundForType(notification.type);

        switch (this.platform) {
            case 'darwin':
                return this._sendMacOS(title, message, sound);
            case 'linux':
                return this._sendLinux(title, message, sound);
            case 'win32':
                return this._sendWindows(title, message, sound);
            default:
                this.logger.warn(`Platform ${this.platform} not supported`);
                return false;
        }
    }

    _getSoundForType(type) {
        const soundMap = {
            completed: this.config.completedSound || 'Glass',
            waiting: this.config.waitingSound || 'Tink'
        };
        return soundMap[type] || 'Glass';
    }

    _sendMacOS(title, message, sound) {
        try {
            const timeout = parseInt(process.env.NOTIFICATION_TIMEOUT) || 3000;

            // Try terminal-notifier first using execFileSync (safe - no shell interpolation)
            try {
                execFileSync('terminal-notifier', [
                    '-title', title,
                    '-message', message,
                    '-sound', sound,
                    '-group', 'claude-code-remote'
                ], { timeout });
                return true;
            } catch (e) {
                // Fallback to osascript with proper escaping
                const escapedTitle = escapeForAppleScript(title);
                const escapedMessage = escapeForAppleScript(message);
                const script = `display notification "${escapedMessage}" with title "${escapedTitle}"`;
                execFileSync('osascript', ['-e', script], { timeout });

                // Play sound separately
                this._playSound(sound);
                return true;
            }
        } catch (error) {
            this.logger.error('macOS notification failed:', error.message);
            return false;
        }
    }

    _sendLinux(title, message, sound) {
        try {
            const notificationTimeout = parseInt(process.env.NOTIFICATION_TIMEOUT) || 3000;
            const displayTime = parseInt(process.env.NOTIFICATION_DISPLAY_TIME) || 10000;

            // Use execFileSync with argument array (safe - no shell interpolation)
            execFileSync('notify-send', [title, message, '-t', String(displayTime)], {
                timeout: notificationTimeout
            });
            this._playSound(sound);
            return true;
        } catch (error) {
            this.logger.error('Linux notification failed:', error.message);
            return false;
        }
    }

    _sendWindows(title, message, sound) {
        try {
            // Escape for PowerShell - replace quotes and backticks
            const escapeForPowerShell = (str) => {
                if (!str) return '';
                return str
                    .replace(/`/g, '``')      // Escape backticks
                    .replace(/"/g, '`"')      // Escape double quotes
                    .replace(/\$/g, '`$')     // Escape dollar signs
                    .replace(/\n/g, '`n')     // Escape newlines
                    .replace(/\r/g, '`r');    // Escape carriage returns
            };

            const safeTitle = escapeForPowerShell(title);
            const safeMessage = escapeForPowerShell(message);

            const script = `
            [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
            $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
            $xml = [xml] $template.GetXml()
            $xml.toast.visual.binding.text[0].AppendChild($xml.CreateTextNode("${safeTitle}")) > $null
            $xml.toast.visual.binding.text[1].AppendChild($xml.CreateTextNode("${safeMessage}")) > $null
            $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
            [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Claude-Code-Remote").Show($toast)
            `;

            // Use execFileSync with argument array (safe - no shell interpolation)
            execFileSync('powershell', ['-Command', script], { timeout: 5000 });
            this._playSound(sound);
            return true;
        } catch (error) {
            this.logger.error('Windows notification failed:', error.message);
            return false;
        }
    }

    _playSound(soundName) {
        if (!soundName || soundName === 'default') return;

        try {
            if (this.platform === 'darwin') {
                const soundPath = `/System/Library/Sounds/${soundName}.aiff`;
                const audioProcess = spawn('afplay', [soundPath], {
                    detached: true,
                    stdio: 'ignore'
                });
                audioProcess.unref();
            } else if (this.platform === 'linux') {
                const soundPath = `/usr/share/sounds/freedesktop/stereo/${soundName.toLowerCase()}.oga`;
                const audioProcess = spawn('paplay', [soundPath], {
                    detached: true,
                    stdio: 'ignore'
                });
                audioProcess.unref();
            } else if (this.platform === 'win32') {
                const audioProcess = spawn('powershell', ['-c', `[console]::beep(800,300)`], {
                    detached: true,
                    stdio: 'ignore'
                });
                audioProcess.unref();
            }
        } catch (error) {
            this.logger.debug('Sound playback failed:', error.message);
        }
    }

    validateConfig() {
        // Desktop notifications don't require configuration
        return true;
    }

    getAvailableSounds() {
        const sounds = {
            'System Sounds': ['Glass', 'Tink', 'Ping', 'Pop', 'Basso', 'Blow', 'Bottle', 
                            'Frog', 'Funk', 'Hero', 'Morse', 'Purr', 'Sosumi', 'Submarine'],
            'Alert Sounds': ['Beep', 'Boop', 'Sosumi', 'Tink', 'Glass'],
            'Nature Sounds': ['Frog', 'Submarine'],
            'Musical Sounds': ['Funk', 'Hero', 'Morse', 'Sosumi']
        };

        // Add custom sounds from assets directory
        try {
            const fs = require('fs');
            if (fs.existsSync(this.soundsDir)) {
                const customSounds = fs.readdirSync(this.soundsDir)
                    .filter(file => /\.(wav|mp3|m4a|aiff|ogg)$/i.test(file))
                    .map(file => path.basename(file, path.extname(file)));
                
                if (customSounds.length > 0) {
                    sounds['Custom Sounds'] = customSounds;
                }
            }
        } catch (error) {
            this.logger.debug('Failed to load custom sounds:', error.message);
        }

        return sounds;
    }
}

module.exports = DesktopChannel;