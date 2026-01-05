/**
 * Tests for Shared Utilities
 * Run with: node --test tests/shared-utils.test.js
 */

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
    generateToken,
    findSessionByToken,
    sanitizeForShell,
    escapeShellArg,
    readSessionMap,
    writeSessionMap,
    getCurrentTmuxSession,
    isTmuxAvailable,
    escapeForAppleScript,
    sanitizeSessionName
} = require('../src/utils/shared');

describe('Token Generation', () => {
    it('should generate 8-character tokens by default', () => {
        const token = generateToken();
        assert.strictEqual(token.length, 8);
    });

    it('should generate tokens of specified length', () => {
        assert.strictEqual(generateToken(4).length, 4);
        assert.strictEqual(generateToken(16).length, 16);
        assert.strictEqual(generateToken(32).length, 32);
    });

    it('should only contain uppercase alphanumeric characters', () => {
        const token = generateToken(100);
        const validChars = /^[A-Z0-9]+$/;
        assert.ok(validChars.test(token), 'Token should only contain A-Z and 0-9');
    });

    it('should generate unique tokens', () => {
        const tokens = new Set();
        for (let i = 0; i < 100; i++) {
            tokens.add(generateToken());
        }
        // With 36^8 possibilities, collisions should be extremely rare
        assert.strictEqual(tokens.size, 100, 'Tokens should be unique');
    });

    it('should be cryptographically random', () => {
        // Generate many tokens and check character distribution
        const charCounts = {};
        for (let i = 0; i < 1000; i++) {
            const token = generateToken(8);
            for (const char of token) {
                charCounts[char] = (charCounts[char] || 0) + 1;
            }
        }

        // Each character should appear at least once
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        for (const char of chars) {
            assert.ok(charCounts[char] > 0, `Character ${char} should appear at least once`);
        }
    });
});

describe('Shell Sanitization', () => {
    it('should allow alphanumeric characters', () => {
        assert.strictEqual(sanitizeForShell('abc123'), 'abc123');
        assert.strictEqual(sanitizeForShell('ABC123'), 'ABC123');
    });

    it('should allow dashes and underscores', () => {
        assert.strictEqual(sanitizeForShell('my-session'), 'my-session');
        assert.strictEqual(sanitizeForShell('my_session'), 'my_session');
    });

    it('should strip dangerous characters', () => {
        assert.strictEqual(sanitizeForShell('session;rm'), 'sessionrm');
        assert.strictEqual(sanitizeForShell('session`id`'), 'sessionid');
        assert.strictEqual(sanitizeForShell('session$(whoami)'), 'sessionwhoami');
        assert.strictEqual(sanitizeForShell('session|cat'), 'sessioncat');
        assert.strictEqual(sanitizeForShell('session&echo'), 'sessionecho');
        assert.strictEqual(sanitizeForShell('session\ntest'), 'sessiontest');
    });

    it('should handle empty and null inputs', () => {
        assert.strictEqual(sanitizeForShell(''), '');
        assert.strictEqual(sanitizeForShell(null), '');
        assert.strictEqual(sanitizeForShell(undefined), '');
    });

    it('should handle non-string inputs', () => {
        assert.strictEqual(sanitizeForShell(123), '');
        assert.strictEqual(sanitizeForShell({}), '');
        assert.strictEqual(sanitizeForShell([]), '');
    });
});

describe('Shell Argument Escaping', () => {
    it('should wrap strings in single quotes', () => {
        assert.strictEqual(escapeShellArg('test'), "'test'");
    });

    it('should escape single quotes', () => {
        assert.strictEqual(escapeShellArg("it's"), "'it'\\''s'");
    });

    it('should handle empty strings', () => {
        assert.strictEqual(escapeShellArg(''), "''");
        assert.strictEqual(escapeShellArg(null), "''");
    });

    it('should handle complex strings', () => {
        const result = escapeShellArg("echo 'hello world'");
        assert.ok(result.includes("\\'"));
    });
});

describe('AppleScript Escaping', () => {
    it('should escape backslashes', () => {
        const result = escapeForAppleScript('path\\to\\file');
        assert.strictEqual(result, 'path\\\\to\\\\file');
    });

    it('should escape double quotes', () => {
        const result = escapeForAppleScript('say "hello"');
        assert.strictEqual(result, 'say \\"hello\\"');
    });

    it('should escape newlines', () => {
        const result = escapeForAppleScript('line1\nline2');
        assert.strictEqual(result, 'line1\\nline2');
    });

    it('should escape carriage returns', () => {
        const result = escapeForAppleScript('line1\rline2');
        assert.strictEqual(result, 'line1\\rline2');
    });

    it('should escape tabs', () => {
        const result = escapeForAppleScript('col1\tcol2');
        assert.strictEqual(result, 'col1\\tcol2');
    });

    it('should handle empty strings', () => {
        assert.strictEqual(escapeForAppleScript(''), '');
        assert.strictEqual(escapeForAppleScript(null), '');
        assert.strictEqual(escapeForAppleScript(undefined), '');
    });

    it('should handle complex strings', () => {
        const input = 'echo "hello\\nworld"\t| grep test';
        const result = escapeForAppleScript(input);

        // Should escape all dangerous characters
        assert.ok(!result.includes('\n')); // literal newline
        assert.ok(!result.includes('\t')); // literal tab
        assert.ok(result.includes('\\n')); // escaped newline
        assert.ok(result.includes('\\t')); // escaped tab
    });
});

describe('Session Name Sanitization', () => {
    it('should allow valid session names', () => {
        assert.strictEqual(sanitizeSessionName('my-session'), 'my-session');
        assert.strictEqual(sanitizeSessionName('session_123'), 'session_123');
        assert.strictEqual(sanitizeSessionName('claude-taskping'), 'claude-taskping');
    });

    it('should remove semicolons', () => {
        assert.strictEqual(sanitizeSessionName('session;rm -rf'), 'sessionrm -rf');
    });

    it('should remove backticks', () => {
        assert.strictEqual(sanitizeSessionName('session`id`'), 'sessionid');
    });

    it('should remove dollar signs and parentheses', () => {
        assert.strictEqual(sanitizeSessionName('session$(whoami)'), 'sessionwhoami');
    });

    it('should remove pipe characters', () => {
        assert.strictEqual(sanitizeSessionName('session|cat'), 'sessioncat');
    });

    it('should remove newlines and carriage returns', () => {
        assert.strictEqual(sanitizeSessionName('session\ntest'), 'sessiontest');
        assert.strictEqual(sanitizeSessionName('session\rtest'), 'sessiontest');
    });

    it('should remove ampersands', () => {
        assert.strictEqual(sanitizeSessionName('session&echo'), 'sessionecho');
        assert.strictEqual(sanitizeSessionName('session&&echo'), 'sessionecho');
    });

    it('should remove angle brackets', () => {
        assert.strictEqual(sanitizeSessionName('session<file'), 'sessionfile');
        assert.strictEqual(sanitizeSessionName('session>file'), 'sessionfile');
    });

    it('should handle empty and null inputs', () => {
        assert.strictEqual(sanitizeSessionName(''), '');
        assert.strictEqual(sanitizeSessionName(null), '');
        assert.strictEqual(sanitizeSessionName(undefined), '');
    });

    it('should handle non-string inputs', () => {
        assert.strictEqual(sanitizeSessionName(123), '');
        assert.strictEqual(sanitizeSessionName({}), '');
    });

    it('should handle strings with only dangerous characters', () => {
        assert.strictEqual(sanitizeSessionName(';`$()|\n\r&<>'), '');
    });
});

describe('Tmux Utilities', () => {
    it('isTmuxAvailable should return boolean', () => {
        const result = isTmuxAvailable();
        assert.strictEqual(typeof result, 'boolean');
    });

    it('getCurrentTmuxSession should return string or null', () => {
        const result = getCurrentTmuxSession();
        assert.ok(result === null || typeof result === 'string');
    });
});

describe('Session Map', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    it('should return empty object for non-existent file', () => {
        const result = readSessionMap('/non/existent/path.json');
        assert.deepStrictEqual(result, {});
    });

    it('should read and write session map', () => {
        const tempDir = os.tmpdir();
        const mapPath = path.join(tempDir, `test-session-map-${Date.now()}.json`);

        try {
            const testData = {
                ABC12345: { type: 'pty', createdAt: Date.now() }
            };

            writeSessionMap(mapPath, testData);
            const result = readSessionMap(mapPath);

            assert.deepStrictEqual(result, testData);
        } finally {
            // Cleanup
            if (fs.existsSync(mapPath)) {
                fs.unlinkSync(mapPath);
            }
        }
    });

    it('should handle invalid JSON gracefully', () => {
        const tempDir = os.tmpdir();
        const mapPath = path.join(tempDir, `test-invalid-map-${Date.now()}.json`);

        try {
            fs.writeFileSync(mapPath, 'invalid json');
            const result = readSessionMap(mapPath);
            assert.deepStrictEqual(result, {});
        } finally {
            if (fs.existsSync(mapPath)) {
                fs.unlinkSync(mapPath);
            }
        }
    });

    it('should create directories when writing', () => {
        const tempDir = os.tmpdir();
        const nestedPath = path.join(tempDir, `nested-${Date.now()}`, 'dir', 'map.json');

        try {
            const testData = { test: 'data' };
            writeSessionMap(nestedPath, testData);

            assert.ok(fs.existsSync(nestedPath));
            const result = readSessionMap(nestedPath);
            assert.deepStrictEqual(result, testData);
        } finally {
            // Cleanup
            const baseDir = path.dirname(path.dirname(nestedPath));
            if (fs.existsSync(baseDir)) {
                fs.rmSync(baseDir, { recursive: true });
            }
        }
    });
});

describe('Find Session By Token', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    it('should return null for non-existent session', () => {
        const tempDir = path.join(os.tmpdir(), `test-sessions-${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        try {
            const result = findSessionByToken('NONEXIST', tempDir);
            assert.strictEqual(result, null);
        } finally {
            fs.rmSync(tempDir, { recursive: true });
        }
    });

    it('should find session by token', () => {
        const tempDir = path.join(os.tmpdir(), `test-sessions-${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        try {
            const session = {
                id: 'test-session-id',
                token: 'ABC12345',
                createdAt: Date.now()
            };

            fs.writeFileSync(
                path.join(tempDir, 'test-session.json'),
                JSON.stringify(session)
            );

            const result = findSessionByToken('ABC12345', tempDir);
            assert.deepStrictEqual(result, session);
        } finally {
            fs.rmSync(tempDir, { recursive: true });
        }
    });

    it('should handle null inputs', () => {
        assert.strictEqual(findSessionByToken(null, '/tmp'), null);
        assert.strictEqual(findSessionByToken('ABC12345', null), null);
    });

    it('should handle invalid JSON files gracefully', () => {
        const tempDir = path.join(os.tmpdir(), `test-sessions-${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        try {
            fs.writeFileSync(
                path.join(tempDir, 'invalid.json'),
                'not json'
            );

            const result = findSessionByToken('ABC12345', tempDir);
            assert.strictEqual(result, null);
        } finally {
            fs.rmSync(tempDir, { recursive: true });
        }
    });
});

describe('Security - Source Code Patterns', () => {
    const fs = require('fs');

    it('should use execFileSync instead of execSync for tmux commands', () => {
        const source = fs.readFileSync(
            require.resolve('../src/utils/shared'),
            'utf8'
        );

        // Should import execFileSync
        assert.ok(source.includes('execFileSync'), 'Should import execFileSync');

        // getCurrentTmuxSession should use execFileSync
        assert.ok(
            source.includes("execFileSync('tmux'") ||
            source.includes('execFileSync("tmux"'),
            'Should call tmux with execFileSync'
        );
    });

    it('should use argument arrays for child_process commands', () => {
        const source = fs.readFileSync(
            require.resolve('../src/utils/shared'),
            'utf8'
        );

        // Should not use template literals with execSync/execFileSync
        const dangerousPattern = /exec(?:File)?Sync\s*\(\s*`/;
        assert.ok(
            !dangerousPattern.test(source),
            'Should not use template literals with exec commands'
        );
    });
});
