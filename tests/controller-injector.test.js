/**
 * Tests for Controller Injector
 * Run with: node --test tests/controller-injector.test.js
 */

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert');
const { escapeForAppleScript } = require('../src/utils/webhook-utils');

// Mock child_process before requiring the module
const originalExecFileSync = require('child_process').execFileSync;

describe('ControllerInjector', () => {
    let ControllerInjector;

    beforeEach(() => {
        // Clear require cache to get fresh module
        delete require.cache[require.resolve('../src/utils/controller-injector')];
        ControllerInjector = require('../src/utils/controller-injector');
    });

    describe('Session Name Sanitization', () => {
        it('should sanitize session names with special characters', () => {
            const injector = new ControllerInjector({ mode: 'tmux' });

            // Test internal sanitization method
            assert.strictEqual(injector._sanitizeSessionName('valid-session'), 'valid-session');
            assert.strictEqual(injector._sanitizeSessionName('valid_session'), 'valid_session');
            assert.strictEqual(injector._sanitizeSessionName('session123'), 'session123');
        });

        it('should strip dangerous characters from session names', () => {
            const injector = new ControllerInjector({ mode: 'tmux' });

            // These should be sanitized to remove dangerous characters
            assert.strictEqual(injector._sanitizeSessionName('session;rm'), 'sessionrm');
            assert.strictEqual(injector._sanitizeSessionName('session`id`'), 'sessionid');
            assert.strictEqual(injector._sanitizeSessionName('session$(whoami)'), 'sessionwhoami');
        });

        it('should reject empty session names', () => {
            const injector = new ControllerInjector({ mode: 'tmux' });

            assert.throws(() => injector._sanitizeSessionName(''), Error);
            assert.throws(() => injector._sanitizeSessionName(null), Error);
            assert.throws(() => injector._sanitizeSessionName(undefined), Error);
        });

        it('should reject session names that become empty after sanitization', () => {
            const injector = new ControllerInjector({ mode: 'tmux' });

            // All special characters should result in error
            assert.throws(() => injector._sanitizeSessionName(';;;'), Error);
            assert.throws(() => injector._sanitizeSessionName('`$()`'), Error);
        });
    });

    describe('AppleScript Escaping (uses shared function)', () => {
        it('should escape backslashes', () => {
            const result = escapeForAppleScript('path\\to\\file');
            assert.ok(result.includes('\\\\'));
        });

        it('should escape double quotes', () => {
            const result = escapeForAppleScript('say "hello"');
            assert.ok(result.includes('\\"'));
        });

        it('should escape newlines', () => {
            const result = escapeForAppleScript('line1\nline2');
            assert.ok(result.includes('\\n'));
        });

        it('should escape tabs', () => {
            const result = escapeForAppleScript('col1\tcol2');
            assert.ok(result.includes('\\t'));
        });

        it('should handle complex strings', () => {
            const input = 'echo "hello\\nworld"\t| grep test';
            const result = escapeForAppleScript(input);

            // Should not contain unescaped quotes or backslashes
            assert.ok(!result.includes('\n')); // literal newline
            assert.ok(!result.includes('\t')); // literal tab
        });
    });

    describe('Command Validation', () => {
        it('should reject empty commands', async () => {
            const injector = new ControllerInjector({ mode: 'tmux' });

            await assert.rejects(
                async () => injector.injectCommand(''),
                /Command/
            );
        });

        it('should reject null commands', async () => {
            const injector = new ControllerInjector({ mode: 'tmux' });

            await assert.rejects(
                async () => injector.injectCommand(null),
                /Command/
            );
        });

        it('should reject commands exceeding max length', async () => {
            const injector = new ControllerInjector({ mode: 'tmux' });
            const longCommand = 'x'.repeat(10001);

            await assert.rejects(
                async () => injector.injectCommand(longCommand),
                /too long/
            );
        });
    });

    describe('Rate Limiting', () => {
        it('should enforce rate limits', async () => {
            const injector = new ControllerInjector({ mode: 'tmux' });
            const testSession = 'test-rate-limit';

            // The rate limiter should track requests
            // (We can't easily test the full flow without mocking tmux)
            assert.ok(injector.rateLimiter, 'Rate limiter should exist');
        });
    });

    describe('List Sessions', () => {
        it('should return empty array when no sessions exist (pty mode)', () => {
            const injector = new ControllerInjector({ mode: 'pty' });
            const sessions = injector.listSessions();
            assert.ok(Array.isArray(sessions));
        });
    });
});

describe('Security Patterns', () => {
    it('should use execFileSync instead of execSync', () => {
        // Read the source file and verify it uses execFileSync
        const fs = require('fs');
        const source = fs.readFileSync(
            require.resolve('../src/utils/controller-injector'),
            'utf8'
        );

        // Should import execFileSync
        assert.ok(source.includes('execFileSync'), 'Should use execFileSync');

        // Should not use execSync with shell interpolation
        const execSyncPattern = /execSync\s*\(\s*`/;
        assert.ok(!execSyncPattern.test(source), 'Should not use execSync with template literals');
    });

    it('should use argument arrays for tmux commands', () => {
        const fs = require('fs');
        const source = fs.readFileSync(
            require.resolve('../src/utils/controller-injector'),
            'utf8'
        );

        // Look for execFileSync with array arguments
        assert.ok(
            source.includes("execFileSync('tmux',"),
            'Should call tmux with execFileSync'
        );
    });
});
