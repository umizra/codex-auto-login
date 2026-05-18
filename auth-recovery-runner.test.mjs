import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  FALLBACK_EMAIL_SELECTORS,
  FALLBACK_PASSWORD_SELECTORS,
  FALLBACK_SUBMIT_SELECTORS,
  FOCUS_PROMPT_SELECTORS,
  MICROSOFT_USE_PASSWORD_SELECTORS,
  PASSKEY_BYPASS_SELECTORS,
  PRIMARY_EMAIL_SELECTORS,
  PRIMARY_PASSWORD_SELECTORS,
  PRIMARY_SUBMIT_SELECTORS,
  accountLabel,
  buildPlannedActions,
  filterAccounts,
  maskEmail,
  parseAccountLine,
  parseCli,
  readAccounts,
} from './auth-recovery-runner.mjs';

test('maskEmail preserves the domain and obscures the local part', () => {
  assert.equal(maskEmail('fixture.user@example.com'), 'fi***@example.com');
  assert.equal(maskEmail('a@b.com'), '**@b.com');
});

test('parseAccountLine reads five colon-separated fields', () => {
  const account = parseAccountLine(
    'alpha@example.com:service-pass:email-pass:fallback@example.net:fallback-pass',
    7,
  );

  assert.deepEqual(account, {
    lineNumber: 7,
    primaryEmail: 'alpha@example.com',
    servicePassword: 'service-pass',
    emailPassword: 'email-pass',
    fallbackEmail: 'fallback@example.net',
    fallbackEmailPassword: 'fallback-pass',
  });
});

test('parseAccountLine rejects malformed rows', () => {
  assert.throws(() => parseAccountLine('a:b:c:d', 2), /expected 5 colon-separated values/);
  assert.throws(() => parseAccountLine('a:b:c:d:e:f', 3), /expected 5 colon-separated values/);
});

test('parseAccountLine preserves special password characters except colon separators', () => {
  const account = parseAccountLine('x@y.com:PnZkOZd2TCh*:8ULiD0rQH!:fb@y.com:goelqckrY!6186', 11);

  assert.equal(account.servicePassword, 'PnZkOZd2TCh*');
  assert.equal(account.emailPassword, '8ULiD0rQH!');
  assert.equal(account.fallbackEmailPassword, 'goelqckrY!6186');
});

test('readAccounts ignores blank lines and comments', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'auth-recovery-'));
  const filePath = path.join(tempDir, 'accounts.txt');
  await writeFile(
    filePath,
    [
      '# comment line',
      '',
      'alpha@example.com:service-pass:email-pass:fallback@example.net:fallback-pass',
      '  ',
      'beta@example.com:service-pass-2:email-pass-2:fallback2@example.net:fallback-pass-2',
      '',
    ].join('\n'),
    'utf8',
  );

  const accounts = await readAccounts(filePath);
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].primaryEmail, 'alpha@example.com');
  assert.equal(accounts[1].fallbackEmail, 'fallback2@example.net');

  const disk = await readFile(filePath, 'utf8');
  assert.match(disk, /beta@example.com/);
});

test('filterAccounts selects one line or a from-line range', () => {
  const accounts = [
    { lineNumber: 2, primaryEmail: 'a@example.com' },
    { lineNumber: 4, primaryEmail: 'b@example.com' },
    { lineNumber: 5, primaryEmail: 'c@example.com' },
  ];

  assert.deepEqual(filterAccounts(accounts, 4, null).map((account) => account.primaryEmail), ['b@example.com']);
  assert.deepEqual(filterAccounts(accounts, null, 4).map((account) => account.primaryEmail), [
    'b@example.com',
    'c@example.com',
  ]);
  assert.deepEqual(filterAccounts(accounts, null, null).map((account) => account.primaryEmail), [
    'a@example.com',
    'b@example.com',
    'c@example.com',
  ]);
});

test('accountLabel reports the original source line after filtering', () => {
  const account = { lineNumber: 8, primaryEmail: 'filtered.user@example.com' };

  assert.equal(accountLabel(account), 'source line 8 (fi***@example.com)');
});

test('selector lists include the expected recovery and sign-in targets', () => {
  assert.ok(PRIMARY_EMAIL_SELECTORS.includes('input[type="email"]'));
  assert.ok(PRIMARY_PASSWORD_SELECTORS.includes('input[type="password"]'));
  assert.ok(PRIMARY_SUBMIT_SELECTORS.includes('button[type="submit"]'));
  assert.ok(PRIMARY_SUBMIT_SELECTORS.includes('button[value="email"]'));
  assert.ok(MICROSOFT_USE_PASSWORD_SELECTORS.includes('button:has-text("Use your password")'));
  assert.ok(PASSKEY_BYPASS_SELECTORS.includes('button:has-text("Not now")'));
  assert.ok(FOCUS_PROMPT_SELECTORS.includes('[data-testid="secondaryButton"]'));

  assert.ok(FALLBACK_EMAIL_SELECTORS.includes('input[name="email"]'));
  assert.ok(FALLBACK_PASSWORD_SELECTORS.includes('input[name="password"]'));
  assert.ok(FALLBACK_SUBMIT_SELECTORS.includes('button:has-text("Login")'));
});

test('buildPlannedActions summarizes the dry-run workflow', () => {
  const account = {
    lineNumber: 12,
    primaryEmail: 'alpha@example.com',
    servicePassword: 'service-pass',
    emailPassword: 'email-pass',
    fallbackEmail: 'fallback@example.net',
    fallbackEmailPassword: 'fallback-pass',
  };

  const actions = buildPlannedActions(account, 0);

  assert.equal(actions.length, 3);
  assert.match(actions[0], /source line 12/);
  assert.match(actions[0], /validate OpenAI email\/password login|OpenAI email\/password login/);
  assert.match(actions[1], /bypass Microsoft passkey prompts/);
  assert.match(actions[2], /run codex-auth batch-login/);
});

test('parseCli recognizes dry-run and a positional accounts file', () => {
  const parsed = parseCli(['node', 'auth-recovery-runner.mjs', '--dry-run', 'custom-accounts.txt']);

  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.accountsFile.endsWith(path.normalize('custom-accounts.txt')), true);
  assert.equal(parsed.lineNumber, null);
  assert.equal(parsed.fromLineNumber, null);
  assert.equal(parsed.fallbackRecovery, false);
});

test('parseCli recognizes opt-in fallback recovery', () => {
  const parsed = parseCli(['node', 'auth-recovery-runner.mjs', 'custom-accounts.txt', '--fallback-recovery']);

  assert.equal(parsed.fallbackRecovery, true);
});

test('parseCli recognizes max failure limit', () => {
  const parsed = parseCli(['node', 'auth-recovery-runner.mjs', 'custom-accounts.txt', '--max-failures', '2']);

  assert.equal(parsed.maxFailures, 2);
});

test('parseCli rejects invalid max failure limit', () => {
  assert.throws(
    () => parseCli(['node', 'auth-recovery-runner.mjs', 'custom-accounts.txt', '--max-failures', '0']),
    /positive integer/,
  );
});

test('parseCli recognizes line selection', () => {
  const parsed = parseCli(['node', 'auth-recovery-runner.mjs', 'custom-accounts.txt', '--line', '2']);

  assert.equal(parsed.lineNumber, 2);
  assert.equal(parsed.fromLineNumber, null);
});

test('parseCli recognizes from-line selection', () => {
  const parsed = parseCli(['node', 'auth-recovery-runner.mjs', 'custom-accounts.txt', '--from-line', '2']);

  assert.equal(parsed.lineNumber, null);
  assert.equal(parsed.fromLineNumber, 2);
});

test('parseCli rejects conflicting line selection', () => {
  assert.throws(
    () => parseCli(['node', 'auth-recovery-runner.mjs', 'custom-accounts.txt', '--line', '1', '--from-line', '2']),
    /cannot be combined/,
  );
});
