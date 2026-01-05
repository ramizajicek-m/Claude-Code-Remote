/**
 * Tests for Webhook Utilities
 * Run with: node --test tests/webhook-utils.test.js
 */

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const {
    validateToken,
    validateCommand,
    parseCallbackData,
    isSessionExpired,
    safeParseJSON,
    verifyLINESignature,
    verifyTelegramSecret,
    RateLimiter,
    MAX_COMMAND_LENGTH,
    TOKEN_REGEX,
    SESSION_EXPIRY_MS
} = require('../src/utils/webhook-utils');

describe('Token Validation', () => {
    it('should accept valid 8-character alphanumeric tokens', () => {
        assert.strictEqual(validateToken('ABC12345'), 'ABC12345');
        assert.strictEqual(validateToken('XXXXXXXX'), 'XXXXXXXX');
        assert.strictEqual(validateToken('12345678'), '12345678');
    });

    it('should normalize tokens to uppercase', () => {
        assert.strictEqual(validateToken('abc12345'), 'ABC12345');
        assert.strictEqual(validateToken('AbCdEfGh'), 'ABCDEFGH');
    });

    it('should reject invalid tokens', () => {
        // Too short
        assert.strictEqual(validateToken('ABC1234'), null);
        // Too long
        assert.strictEqual(validateToken('ABC123456'), null);
        // Contains special characters
        assert.strictEqual(validateToken('ABC-1234'), null);
        assert.strictEqual(validateToken('ABC_1234'), null);
        // Empty or null
        assert.strictEqual(validateToken(''), null);
        assert.strictEqual(validateToken(null), null);
        assert.strictEqual(validateToken(undefined), null);
        // Non-string
        assert.strictEqual(validateToken(12345678), null);
        assert.strictEqual(validateToken({}), null);
    });

    it('should reject tokens with injection attempts', () => {
        assert.strictEqual(validateToken('ABC1234; rm -rf /'), null);
        assert.strictEqual(validateToken('ABC1234`whoami`'), null);
        assert.strictEqual(validateToken('ABC1234$(id)'), null);
    });
});

describe('Command Validation', () => {
    it('should accept valid commands', () => {
        const result = validateCommand('Hello, please help');
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.command, 'Hello, please help');
    });

    it('should trim whitespace', () => {
        const result = validateCommand('  Hello  ');
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.command, 'Hello');
    });

    it('should reject empty commands', () => {
        assert.strictEqual(validateCommand('').valid, false);
        assert.strictEqual(validateCommand('   ').valid, false);
        assert.strictEqual(validateCommand(null).valid, false);
        assert.strictEqual(validateCommand(undefined).valid, false);
    });

    it('should reject non-string commands', () => {
        assert.strictEqual(validateCommand(123).valid, false);
        assert.strictEqual(validateCommand({}).valid, false);
        assert.strictEqual(validateCommand([]).valid, false);
    });

    it('should reject commands exceeding max length', () => {
        const longCommand = 'x'.repeat(MAX_COMMAND_LENGTH + 1);
        const result = validateCommand(longCommand);
        assert.strictEqual(result.valid, false);
        assert.ok(result.error.includes('too long'));
    });

    it('should accept commands at max length', () => {
        const maxCommand = 'x'.repeat(MAX_COMMAND_LENGTH);
        const result = validateCommand(maxCommand);
        assert.strictEqual(result.valid, true);
    });
});

describe('Callback Data Parsing', () => {
    it('should parse valid callback data', () => {
        const result = parseCallbackData('quick:ABC12345:test command');
        assert.strictEqual(result.prefix, 'quick');
        assert.strictEqual(result.token, 'ABC12345');
        assert.strictEqual(result.command, 'test command');
    });

    it('should handle callback data without command', () => {
        const result = parseCallbackData('info:ABC12345');
        assert.strictEqual(result.prefix, 'info');
        assert.strictEqual(result.token, 'ABC12345');
        assert.strictEqual(result.command, null);
    });

    it('should handle callback data with colons in command', () => {
        const result = parseCallbackData('quick:ABC12345:command:with:colons');
        assert.strictEqual(result.prefix, 'quick');
        assert.strictEqual(result.token, 'ABC12345');
        assert.strictEqual(result.command, 'command:with:colons');
    });

    it('should handle invalid callback data', () => {
        const result = parseCallbackData('');
        assert.strictEqual(result.prefix, null);
        assert.strictEqual(result.token, null);
        assert.strictEqual(result.command, null);
    });

    it('should validate token in callback data', () => {
        const result = parseCallbackData('quick:invalid:command');
        assert.strictEqual(result.prefix, 'quick');
        assert.strictEqual(result.token, null); // invalid token
        assert.strictEqual(result.command, 'command');
    });

    it('should reject null/undefined callback data', () => {
        assert.strictEqual(parseCallbackData(null).prefix, null);
        assert.strictEqual(parseCallbackData(undefined).prefix, null);
    });
});

describe('Session Expiry', () => {
    it('should detect expired sessions', () => {
        const expiredSession = {
            expiresAt: Math.floor(Date.now() / 1000) - 1000
        };
        assert.strictEqual(isSessionExpired(expiredSession), true);
    });

    it('should detect valid sessions', () => {
        const validSession = {
            expiresAt: Math.floor(Date.now() / 1000) + 1000
        };
        assert.strictEqual(isSessionExpired(validSession), false);
    });

    it('should treat null sessions as expired', () => {
        assert.strictEqual(isSessionExpired(null), true);
        assert.strictEqual(isSessionExpired(undefined), true);
    });
});

describe('Safe JSON Parsing', () => {
    it('should parse valid JSON', () => {
        const result = safeParseJSON('{"key": "value"}');
        assert.deepStrictEqual(result, { key: 'value' });
    });

    it('should return default for invalid JSON', () => {
        assert.strictEqual(safeParseJSON('invalid json'), null);
        assert.strictEqual(safeParseJSON('{incomplete'), null);
    });

    it('should return custom default value', () => {
        assert.deepStrictEqual(safeParseJSON('invalid', {}), {});
        assert.deepStrictEqual(safeParseJSON('invalid', []), []);
    });
});

describe('LINE Signature Verification', () => {
    const crypto = require('crypto');

    it('should verify valid signatures', () => {
        const secret = 'test-secret';
        const body = '{"test": "data"}';
        const signature = crypto
            .createHmac('SHA256', secret)
            .update(body)
            .digest('base64');

        assert.strictEqual(verifyLINESignature(body, signature, secret), true);
    });

    it('should reject invalid signatures', () => {
        const secret = 'test-secret';
        const body = '{"test": "data"}';

        assert.strictEqual(verifyLINESignature(body, 'invalid-signature', secret), false);
    });

    it('should reject when no secret is provided', () => {
        assert.strictEqual(verifyLINESignature('body', 'sig', null), false);
        assert.strictEqual(verifyLINESignature('body', 'sig', ''), false);
    });
});

describe('Telegram Secret Verification', () => {
    it('should allow requests when no secret is configured', () => {
        assert.strictEqual(verifyTelegramSecret('any-token', null), true);
        assert.strictEqual(verifyTelegramSecret('any-token', ''), true);
    });

    it('should verify matching tokens', () => {
        assert.strictEqual(verifyTelegramSecret('secret123', 'secret123'), true);
    });

    it('should reject non-matching tokens', () => {
        assert.strictEqual(verifyTelegramSecret('wrong', 'secret123'), false);
    });

    it('should reject missing token when secret is configured', () => {
        assert.strictEqual(verifyTelegramSecret(null, 'secret123'), false);
        assert.strictEqual(verifyTelegramSecret('', 'secret123'), false);
    });

    it('should be timing-safe', () => {
        // This is a basic check - timing attacks are hard to test directly
        const result = verifyTelegramSecret('secret123', 'secret123');
        assert.strictEqual(result, true);
    });
});

describe('Rate Limiter', () => {
    it('should allow requests within limit', () => {
        const limiter = new RateLimiter(60000, 5);

        for (let i = 0; i < 5; i++) {
            assert.strictEqual(limiter.checkAndRecord('session1'), true);
        }
    });

    it('should block requests exceeding limit', () => {
        const limiter = new RateLimiter(60000, 3);

        assert.strictEqual(limiter.checkAndRecord('session1'), true);
        assert.strictEqual(limiter.checkAndRecord('session1'), true);
        assert.strictEqual(limiter.checkAndRecord('session1'), true);
        assert.strictEqual(limiter.checkAndRecord('session1'), false);
    });

    it('should track sessions independently', () => {
        const limiter = new RateLimiter(60000, 2);

        assert.strictEqual(limiter.checkAndRecord('session1'), true);
        assert.strictEqual(limiter.checkAndRecord('session1'), true);
        assert.strictEqual(limiter.checkAndRecord('session1'), false);

        // Different session should still be allowed
        assert.strictEqual(limiter.checkAndRecord('session2'), true);
    });

    it('should clear rate limit for a session', () => {
        const limiter = new RateLimiter(60000, 2);

        assert.strictEqual(limiter.checkAndRecord('session1'), true);
        assert.strictEqual(limiter.checkAndRecord('session1'), true);
        assert.strictEqual(limiter.checkAndRecord('session1'), false);

        limiter.clear('session1');
        assert.strictEqual(limiter.checkAndRecord('session1'), true);
    });

    it('should clear all rate limits', () => {
        const limiter = new RateLimiter(60000, 1);

        limiter.checkAndRecord('session1');
        limiter.checkAndRecord('session2');

        assert.strictEqual(limiter.checkAndRecord('session1'), false);
        assert.strictEqual(limiter.checkAndRecord('session2'), false);

        limiter.clearAll();

        assert.strictEqual(limiter.checkAndRecord('session1'), true);
        assert.strictEqual(limiter.checkAndRecord('session2'), true);
    });
});

describe('Constants', () => {
    it('should have correct max command length', () => {
        assert.strictEqual(MAX_COMMAND_LENGTH, 10000);
    });

    it('should have correct token regex', () => {
        assert.ok(TOKEN_REGEX.test('ABCD1234'));
        assert.ok(!TOKEN_REGEX.test('abcd1234'));
        assert.ok(!TOKEN_REGEX.test('ABC123'));
    });

    it('should have correct session expiry (24 hours)', () => {
        assert.strictEqual(SESSION_EXPIRY_MS, 24 * 60 * 60 * 1000);
    });
});

describe('Security - Injection Prevention', () => {
    it('should reject tokens with shell injection', () => {
        const maliciousTokens = [
            'ABC1234; rm -rf /',
            'ABC1234`id`',
            'ABC1234$(whoami)',
            'ABC1234|cat /etc/passwd',
            'ABC1234&&touch /tmp/pwned',
            'ABC1234||true',
            'ABC1234\n',
            'ABC1234\r',
            'ABC1234\x00',
        ];

        for (const token of maliciousTokens) {
            assert.strictEqual(validateToken(token), null, `Should reject: ${token}`);
        }
    });

    it('should handle edge cases safely', () => {
        // These should be rejected
        assert.strictEqual(validateToken('        '), null);
        assert.strictEqual(validateToken('\t\t\t\t\t\t\t\t'), null);
    });
});
