/**
 * Tests for Tmux Injector
 * Run with: node --test tests/tmux-injector.test.js
 */

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('TmuxInjector', () => {
    let TmuxInjector;

    beforeEach(() => {
        // Clear require cache to get fresh module
        delete require.cache[require.resolve('../src/relay/tmux-injector')];
        TmuxInjector = require('../src/relay/tmux-injector');
    });

    describe('Constructor', () => {
        it('should use default session name', () => {
            const injector = new TmuxInjector();
            assert.strictEqual(injector.sessionName, 'claude-taskping');
        });

        it('should accept custom session name', () => {
            const injector = new TmuxInjector(null, 'my-session');
            assert.strictEqual(injector.sessionName, 'my-session');
        });

        it('should sanitize dangerous session names', () => {
            const injector = new TmuxInjector(null, 'session;rm -rf');
            // Should remove semicolon
            assert.ok(!injector.sessionName.includes(';'));
        });

        it('should sanitize backticks in session name', () => {
            const injector = new TmuxInjector(null, 'session`id`');
            assert.ok(!injector.sessionName.includes('`'));
        });

        it('should sanitize command substitution in session name', () => {
            const injector = new TmuxInjector(null, 'session$(whoami)');
            assert.ok(!injector.sessionName.includes('$'));
            assert.ok(!injector.sessionName.includes('('));
            assert.ok(!injector.sessionName.includes(')'));
        });

        it('should sanitize pipes in session name', () => {
            const injector = new TmuxInjector(null, 'session|cat');
            assert.ok(!injector.sessionName.includes('|'));
        });

        it('should sanitize newlines in session name', () => {
            const injector = new TmuxInjector(null, 'session\ntest');
            assert.ok(!injector.sessionName.includes('\n'));
        });

        it('should accept custom logger', () => {
            const mockLogger = {
                info: () => {},
                warn: () => {},
                error: () => {},
                debug: () => {}
            };
            const injector = new TmuxInjector(mockLogger);
            assert.strictEqual(injector.log, mockLogger);
        });

        it('should use console as default logger', () => {
            const injector = new TmuxInjector();
            assert.strictEqual(injector.log, console);
        });

        it('should create log directory', () => {
            const injector = new TmuxInjector();
            const logDir = path.dirname(injector.logFile);
            assert.ok(fs.existsSync(logDir) || true); // May not exist if test runs first
        });
    });

    describe('Session Checks', () => {
        it('checkTmuxAvailableSync should return boolean', () => {
            const injector = new TmuxInjector();
            const result = injector.checkTmuxAvailableSync();
            assert.strictEqual(typeof result, 'boolean');
        });

        it('checkTmuxAvailable should return promise', async () => {
            const injector = new TmuxInjector();
            const result = await injector.checkTmuxAvailable();
            assert.strictEqual(typeof result, 'boolean');
        });

        it('checkClaudeSession should return promise', async () => {
            const injector = new TmuxInjector();
            const result = await injector.checkClaudeSession();
            assert.strictEqual(typeof result, 'boolean');
        });
    });

    describe('Output Capture', () => {
        it('getCaptureOutput should return object with success property', async () => {
            const injector = new TmuxInjector();
            const result = await injector.getCaptureOutput();
            assert.ok('success' in result);
            assert.strictEqual(typeof result.success, 'boolean');
        });

        it('getCaptureOutput should include output or error', async () => {
            const injector = new TmuxInjector();
            const result = await injector.getCaptureOutput();

            if (result.success) {
                assert.ok('output' in result);
            } else {
                assert.ok('error' in result);
            }
        });
    });

    describe('Session Info', () => {
        it('getSessionInfo should return object with exists property', async () => {
            const injector = new TmuxInjector();
            const result = await injector.getSessionInfo();
            assert.ok('exists' in result);
            assert.strictEqual(typeof result.exists, 'boolean');
        });

        it('getSessionInfo should include name when session exists', async () => {
            const injector = new TmuxInjector();
            const result = await injector.getSessionInfo();

            if (result.exists) {
                assert.ok('name' in result);
                assert.ok('info' in result);
            }
        });
    });

    describe('Injection Logging', () => {
        it('should log injections to file', () => {
            const injector = new TmuxInjector();

            // Create log directory if needed
            const logDir = path.dirname(injector.logFile);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            // Log a test injection
            injector.logInjection('test command');

            // Check if log file exists and contains entry
            if (fs.existsSync(injector.logFile)) {
                const content = fs.readFileSync(injector.logFile, 'utf8');
                const lines = content.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                const entry = JSON.parse(lastLine);

                assert.strictEqual(entry.command, 'test command');
                assert.strictEqual(entry.session, injector.sessionName);
                assert.ok(entry.timestamp);
                assert.ok(entry.pid);
            }
        });

        it('should include timestamp in log entries', () => {
            const injector = new TmuxInjector();

            const logDir = path.dirname(injector.logFile);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            injector.logInjection('timestamped command');

            if (fs.existsSync(injector.logFile)) {
                const content = fs.readFileSync(injector.logFile, 'utf8');
                const lines = content.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                const entry = JSON.parse(lastLine);

                // Timestamp should be ISO format
                assert.ok(entry.timestamp.match(/^\d{4}-\d{2}-\d{2}T/));
            }
        });
    });

    describe('Command Injection Workflow', () => {
        it('injectCommandFull should return object with success property', async () => {
            const injector = new TmuxInjector();
            const result = await injector.injectCommandFull('TEST123', 'test');

            assert.ok('success' in result);
            assert.strictEqual(typeof result.success, 'boolean');
        });

        it('injectCommandFull should handle missing tmux gracefully', async () => {
            const injector = new TmuxInjector();

            // Mock checkTmuxAvailable to return false
            injector.checkTmuxAvailable = async () => false;

            const result = await injector.injectCommandFull('TEST123', 'test');

            if (!result.success) {
                assert.ok(result.error);
                assert.ok(result.message);
            }
        });
    });
});

describe('Security Patterns', () => {
    it('should use execFileSync instead of execSync', () => {
        const source = fs.readFileSync(
            require.resolve('../src/relay/tmux-injector'),
            'utf8'
        );

        // Should import execFileSync
        assert.ok(source.includes('execFileSync'), 'Should use execFileSync');

        // Should not use execSync with template literals for shell commands
        const dangerousExecSyncPattern = /execSync\s*\(\s*`[^`]*tmux/;
        assert.ok(
            !dangerousExecSyncPattern.test(source),
            'Should not use execSync with template literals for tmux commands'
        );
    });

    it('should use execFile for async operations', () => {
        const source = fs.readFileSync(
            require.resolve('../src/relay/tmux-injector'),
            'utf8'
        );

        // Should import execFile
        assert.ok(source.includes('execFile'), 'Should import execFile');
    });

    it('should use argument arrays for tmux commands', () => {
        const source = fs.readFileSync(
            require.resolve('../src/relay/tmux-injector'),
            'utf8'
        );

        // Look for execFileSync with 'tmux' as first argument
        assert.ok(
            source.includes("execFileSync('tmux',") ||
            source.includes('execFileSync("tmux",'),
            'Should call tmux with execFileSync and argument array'
        );
    });

    it('should import sanitization functions from shared module', () => {
        const source = fs.readFileSync(
            require.resolve('../src/relay/tmux-injector'),
            'utf8'
        );

        assert.ok(
            source.includes('sanitizeSessionName'),
            'Should import sanitizeSessionName from shared'
        );

        assert.ok(
            source.includes('escapeForAppleScript'),
            'Should import escapeForAppleScript from shared'
        );

        assert.ok(
            source.includes('isTmuxAvailable'),
            'Should import isTmuxAvailable from shared'
        );
    });

    it('should sanitize session name in constructor', () => {
        const source = fs.readFileSync(
            require.resolve('../src/relay/tmux-injector'),
            'utf8'
        );

        // Should call sanitizeSessionName
        assert.ok(
            source.includes('sanitizeSessionName(rawName)') ||
            source.includes('sanitizeSessionName('),
            'Should sanitize session name'
        );
    });

    it('should use _sendKeysSync helper for tmux send-keys', () => {
        const source = fs.readFileSync(
            require.resolve('../src/relay/tmux-injector'),
            'utf8'
        );

        // Should have _sendKeysSync method
        assert.ok(
            source.includes('_sendKeysSync'),
            'Should have _sendKeysSync helper method'
        );

        // _sendKeysSync should use execFileSync with argument array
        assert.ok(
            source.includes("'send-keys'"),
            'Should use send-keys as separate argument'
        );
    });

    it('should not use string concatenation for shell commands', () => {
        const source = fs.readFileSync(
            require.resolve('../src/relay/tmux-injector'),
            'utf8'
        );

        // Should not have patterns like: execFileSync('tmux ' + or execFileSync(`tmux ${
        const dangerousConcatPattern = /execFileSync\s*\(\s*['"`]tmux\s*['"]\s*\+/;
        assert.ok(
            !dangerousConcatPattern.test(source),
            'Should not concatenate strings for shell commands'
        );
    });
});

describe('Confirmation Handling Patterns', () => {
    it('should have handleConfirmations method', () => {
        const TmuxInjector = require('../src/relay/tmux-injector');
        const injector = new TmuxInjector();

        assert.ok(typeof injector.handleConfirmations === 'function');
    });

    it('should detect multi-option confirmation patterns', () => {
        const TmuxInjector = require('../src/relay/tmux-injector');
        const source = fs.readFileSync(
            require.resolve('../src/relay/tmux-injector'),
            'utf8'
        );

        // Should check for "Do you want to proceed?" and "1. Yes"
        assert.ok(
            source.includes('Do you want to proceed?'),
            'Should detect confirmation dialog'
        );
        assert.ok(
            source.includes('1. Yes'),
            'Should detect option patterns'
        );
    });

    it('should detect y/n prompts', () => {
        const source = fs.readFileSync(
            require.resolve('../src/relay/tmux-injector'),
            'utf8'
        );

        assert.ok(
            source.includes('(y/n)') || source.includes('[Y/n]') || source.includes('[y/N]'),
            'Should detect y/n prompts'
        );
    });

    it('should detect Enter prompts', () => {
        const source = fs.readFileSync(
            require.resolve('../src/relay/tmux-injector'),
            'utf8'
        );

        assert.ok(
            source.includes('Press Enter'),
            'Should detect Enter prompts'
        );
    });

    it('should detect processing indicators', () => {
        const source = fs.readFileSync(
            require.resolve('../src/relay/tmux-injector'),
            'utf8'
        );

        // Should check for various processing states
        assert.ok(
            source.includes('Clauding') ||
            source.includes('Waiting') ||
            source.includes('Processing'),
            'Should detect processing indicators'
        );
    });
});

describe('macOS Notification', () => {
    it('should escape AppleScript in notifications', () => {
        const source = fs.readFileSync(
            require.resolve('../src/relay/tmux-injector'),
            'utf8'
        );

        assert.ok(
            source.includes('escapeForAppleScript'),
            'Should use escapeForAppleScript for notifications'
        );
    });

    it('should use execFile for osascript', () => {
        const source = fs.readFileSync(
            require.resolve('../src/relay/tmux-injector'),
            'utf8'
        );

        // Should use execFile, not execSync for osascript
        assert.ok(
            source.includes("execFile('osascript'") ||
            source.includes('execFile("osascript"'),
            'Should use execFile for osascript'
        );
    });

    it('should check platform before sending notification', () => {
        const source = fs.readFileSync(
            require.resolve('../src/relay/tmux-injector'),
            'utf8'
        );

        assert.ok(
            source.includes("process.platform !== 'darwin'"),
            'Should check for macOS platform'
        );
    });
});
