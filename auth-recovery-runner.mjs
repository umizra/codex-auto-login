#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';

const PRIMARY_URL = process.env.PRIMARY_URL ?? 'codex-auth OAuth authorize URL';
const FALLBACK_URL = process.env.FALLBACK_URL ?? 'https://firstmail.ltd';
const DEFAULT_TIMEOUT = Number(process.env.TIMEOUT_MS ?? 30_000);
const HEADLESS = process.env.HEADLESS !== 'false';
const SESSION_DIR = process.env.SESSION_DIR ?? path.resolve(process.cwd(), '.auth-sessions');
const NO_OPEN_BIN_DIR = path.resolve(process.cwd(), '.auth-bin');
const CHROME_PATH =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ARTIFACT_DIR = process.env.ARTIFACT_DIR ?? path.resolve(process.cwd(), 'auth-run-artifacts');

const PRIMARY_EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="loginfmt"]',
  'input[autocomplete="username"]',
  'input[aria-label*="email" i]',
];

const PRIMARY_PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="passwd"]',
  'input[autocomplete="current-password"]',
  'input[aria-label*="password" i]',
];

const PRIMARY_SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button[value="email"]',
  'button:has-text("Next")',
  'button:has-text("Continue")',
  'button:has-text("Sign in")',
];

const MICROSOFT_USE_PASSWORD_SELECTORS = [
  'button:has-text("Use your password")',
  'input[value="Use your password"]',
  'text=Use your password',
];

const PASSKEY_BYPASS_SELECTORS = [
  'button:has-text("Skip")',
  'button:has-text("Not now")',
  'button:has-text("Cancel")',
  'input[value="Skip"]',
  'input[value="Not now"]',
  'input[value="Cancel"]',
  '#idBtn_Back',
];

const FOCUS_PROMPT_SELECTORS = [
  '[data-testid="secondaryButton"]',
  'button:has-text("No")',
  'button:has-text("Yes")',
  'button:has-text("Stay signed in")',
];

const FALLBACK_EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[autocomplete="username"]',
  'input[placeholder*="email" i]',
];

const FALLBACK_PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[autocomplete="current-password"]',
  'input[placeholder*="password" i]',
];

const FALLBACK_SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Next")',
  'button:has-text("Login")',
  'button:has-text("Sign in")',
  'button:has-text("Verify")',
];

function parseCli(argv) {
  let accountsFile = path.resolve(process.cwd(), 'accounts.txt');
  let dryRun = false;
  let lineNumber = null;
  let fromLineNumber = null;
  let fallbackRecovery = false;
  let maxFailures = Number.POSITIVE_INFINITY;
  let skipExisting = true;
  let concurrency = 1;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--fallback-recovery') {
      fallbackRecovery = true;
      continue;
    }
    if (arg === '--no-skip-existing') {
      skipExisting = false;
      continue;
    }
    if (arg === '--max-failures') {
      const value = args[i + 1];
      if (!value) {
        throw new Error('--max-failures requires a value');
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
        throw new Error('--max-failures must be a positive integer');
      }
      maxFailures = parsed;
      i += 1;
      continue;
    }
    if (arg === '--concurrency') {
      const value = args[i + 1];
      if (!value) {
        throw new Error('--concurrency requires a value');
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
        throw new Error('--concurrency must be a positive integer');
      }
      concurrency = parsed;
      i += 1;
      continue;
    }
    if (arg === '--line' || arg === '--from-line') {
      const value = args[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
        throw new Error(`${arg} must be a positive integer`);
      }
      if (arg === '--line') {
        if (fromLineNumber !== null) throw new Error('--line cannot be combined with --from-line');
        lineNumber = parsed;
      } else {
        if (lineNumber !== null) throw new Error('--from-line cannot be combined with --line');
        fromLineNumber = parsed;
      }
      i += 1;
      continue;
    }

    if (!arg.startsWith('-') && accountsFile === path.resolve(process.cwd(), 'accounts.txt')) {
      accountsFile = path.resolve(arg);
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    accountsFile,
    dryRun,
    lineNumber,
    fromLineNumber,
    fallbackRecovery,
    maxFailures,
    skipExisting,
    concurrency,
  };
}

const {
  accountsFile: ACCOUNTS_FILE,
  dryRun: DRY_RUN,
  lineNumber: LINE_NUMBER,
  fromLineNumber: FROM_LINE_NUMBER,
  fallbackRecovery: FALLBACK_RECOVERY,
  maxFailures: MAX_FAILURES,
  skipExisting: SKIP_EXISTING,
  concurrency: CONCURRENCY,
} = parseCli(process.argv);

function timestamp() {
  return new Date().toISOString();
}

function log(level, message) {
  console.log(`[${timestamp()}] [${level}] ${message}`);
}

function info(message) {
  log('INFO', message);
}

function success(message) {
  log('SUCCESS', message);
}

function warn(message) {
  log('WARN', message);
}

function error(message) {
  log('ERROR', message);
}

function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  if (!name || !domain) return String(email);
  if (name.length <= 2) return `**@${domain}`;
  return `${name.slice(0, 2)}***@${domain}`;
}

function accountSessionDir(account) {
  const safeEmail = account.primaryEmail.replace(/[^a-z0-9._-]+/gi, '_');
  return path.join(SESSION_DIR, `line-${account.lineNumber}-${safeEmail}`);
}

function artifactPrefix(account) {
  const safeEmail = account.primaryEmail.replace(/[^a-z0-9._-]+/gi, '_');
  return path.join(ARTIFACT_DIR, `line-${account.lineNumber}-${safeEmail}`);
}

function accountLabel(account) {
  return `source line ${account.lineNumber} (${maskEmail(account.primaryEmail)})`;
}

async function getAvailablePort(preferredPort) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.on('error', () => {
      const fallback = createServer();
      fallback.unref();
      fallback.listen(0, '127.0.0.1', () => {
        const address = fallback.address();
        const port = typeof address === 'object' && address ? address.port : preferredPort + 1;
        fallback.close(() => resolve(port));
      });
    });
    server.listen(preferredPort, '127.0.0.1', () => {
      server.close(() => resolve(preferredPort));
    });
  });
}

function preferredChromeDebugPort(account) {
  return 9100 + account.lineNumber;
}

function parseAccountLine(line, lineNumber) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const parts = trimmed.split(':');
  if (parts.length !== 5) {
    throw new Error(`Line ${lineNumber}: expected 5 colon-separated values, found ${parts.length}`);
  }

  const [primaryEmail, servicePassword, emailPassword, fallbackEmail, fallbackEmailPassword] = parts.map((part) => part.trim());
  if (!primaryEmail || !servicePassword || !emailPassword || !fallbackEmail || !fallbackEmailPassword) {
    throw new Error(`Line ${lineNumber}: one or more values are empty`);
  }

  return {
    lineNumber,
    primaryEmail,
    servicePassword,
    emailPassword,
    fallbackEmail,
    fallbackEmailPassword,
  };
}

function buildPlannedActions(account, index) {
  const label = account.lineNumber ? accountLabel(account) : `account #${index + 1} (${maskEmail(account.primaryEmail)})`;
  const actions = [
    `${label}: start codex-auth and validate OpenAI email/password login on its OAuth page`,
    `${label}: bypass Microsoft passkey prompts and prefer password when login.live.com appears`,
    `${label}: run codex-auth batch-login for source line ${account.lineNumber ?? index + 1}`,
  ];
  if (FALLBACK_RECOVERY) {
    actions.push(`${label}: if primary flow fails, recover at ${FALLBACK_URL} using ${maskEmail(account.fallbackEmail)}`);
  }
  return actions;
}

async function readAccounts(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const accounts = raw
    .split(/\r?\n/)
    .map((line, index) => parseAccountLine(line, index + 1))
    .filter(Boolean);
  return filterAccounts(accounts, LINE_NUMBER, FROM_LINE_NUMBER);
}

function filterAccounts(accounts, lineNumber, fromLineNumber) {
  if (lineNumber !== null) {
    return accounts.filter((account) => account.lineNumber === lineNumber);
  }
  if (fromLineNumber !== null) {
    return accounts.filter((account) => account.lineNumber >= fromLineNumber);
  }
  return accounts;
}

function parseCodexAuthList(output) {
  const entries = new Map();
  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^\*?\s*\d+\s+(\S+@\S+)\s+(.*)$/);
    if (!match) continue;

    const [, email, statusText] = match;
    entries.set(email.toLowerCase(), {
      email,
      statusText: statusText.trim(),
    });
  }
  return entries;
}

function isRegistryEntryUsable(entry) {
  if (!entry) return false;
  const unhealthyPattern = /\b(401|403|timedout|timeout|token_expired|expired|unauthorized|forbidden|error|failed|invalid)\b/i;
  return !unhealthyPattern.test(entry.statusText);
}

function filterExistingUsableAccounts(accounts, registryEntries) {
  const selected = [];
  const skipped = [];

  for (const account of accounts) {
    const entry = registryEntries.get(account.primaryEmail.toLowerCase());
    if (isRegistryEntryUsable(entry)) {
      skipped.push({ account, entry });
    } else {
      selected.push(account);
    }
  }

  return { selected, skipped };
}

async function collectChildOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });
  });
}

async function loadCodexAuthRegistry() {
  const { stdout } = await collectChildOutput('codex-auth', ['list']);
  return parseCodexAuthList(stdout);
}

async function waitForVisibleAny(page, selectors, timeout = DEFAULT_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let lastError;

  for (const selector of selectors) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: remaining });
      return locator;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error(`None of the selectors became visible: ${selectors.join(', ')}`);
}

async function fillVisible(page, selectors, value, label) {
  const field = await waitForVisibleAny(page, selectors);
  await field.fill(value);
  info(`Filled ${label}`);
  return field;
}

async function clickVisible(page, selectors, label) {
  const button = await waitForVisibleAny(page, selectors);
  await button.click();
  info(`Clicked ${label}`);
  return button;
}

async function handleMaybeVisible(page, selectors, action, timeout = 3_000) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout });
      await action(locator);
      return true;
    } catch {
      // Ignore and continue to the next selector.
    }
  }
  return false;
}

async function clickFirstVisibleIfPresent(page, selectors, label, timeout = 3_000) {
  const clicked = await handleMaybeVisible(
    page,
    selectors,
    async (locator) => {
      await locator.click();
      info(`Clicked ${label}`);
    },
    timeout,
  );
  return clicked;
}

async function preferMicrosoftPasswordIfPrompted(page) {
  if (!/login\.live\.com|login\.microsoft\.com|account\.live\.com/i.test(page.url())) {
    return false;
  }
  return clickFirstVisibleIfPresent(page, MICROSOFT_USE_PASSWORD_SELECTORS, 'Microsoft "Use your password"', 5_000);
}

async function bypassPasskeyIfPrompted(page) {
  if (!/passkey|fido|webauthn/i.test(page.url())) {
    return false;
  }

  const clicked = await clickFirstVisibleIfPresent(page, PASSKEY_BYPASS_SELECTORS, 'passkey bypass', 5_000);
  if (clicked) {
    await page.waitForLoadState('domcontentloaded', { timeout: DEFAULT_TIMEOUT }).catch(() => {});
    return true;
  }

  const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  if (/passkey created/i.test(bodyText)) {
    return clickFirstVisibleIfPresent(page, ['button:has-text("OK")', 'input[value="OK"]'], 'passkey confirmation', 5_000);
  }

  return false;
}

function waitForCodexAuthUrl(child, primaryEmail) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timed out waiting for codex-auth OAuth URL for ${maskEmail(primaryEmail)}`));
    }, DEFAULT_TIMEOUT);

    let settled = false;
    let output = '';
    const urlPattern = /https:\/\/auth\.openai\.com\/oauth\/authorize[^\s]+/;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };

    const collect = (chunk, level) => {
      const text = chunk.toString();
      output += text;
      const match = output.match(urlPattern);
      if (match) {
        settle(resolve, match[0]);
        return;
      }
      for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        if (/^error:/i.test(line)) {
          warn(`codex-auth ${level}: ${line}`);
        }
      }
    };

    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));
    child.on('error', (err) => settle(reject, err));
    child.on('exit', (code) => {
      if (!settled && code !== 0) {
        settle(reject, new Error(`codex-auth exited before printing OAuth URL with code ${code}`));
      }
    });
  });
}

function waitForCodexAuthExit(child, primaryEmail) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timed out waiting for codex-auth completion for ${maskEmail(primaryEmail)}`));
    }, DEFAULT_TIMEOUT * 6);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (stdout.trim()) info(`codex-auth stdout: ${stdout.trim()}`);
      if (stderr.trim()) warn(`codex-auth stderr: ${stderr.trim()}`);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`codex-auth exited with code ${code}`));
      }
    });
  });
}

async function captureFailureArtifacts(page, account, reason) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const prefix = artifactPrefix(account);
  const safeReason = String(reason).replace(/\s+/g, ' ').slice(0, 500);
  const dom = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body?.innerText ?? '',
    inputs: Array.from(document.querySelectorAll('input')).map((input) => ({
      type: input.type,
      name: input.name,
      id: input.id,
      placeholder: input.placeholder,
      aria: input.getAttribute('aria-label'),
      value: input.type === 'password' ? '<password>' : input.value,
    })),
    buttons: Array.from(document.querySelectorAll('button')).map((button) => ({
      type: button.type,
      text: button.innerText,
      value: button.value,
      disabled: button.disabled,
    })),
  })).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));

  await page.screenshot({ path: `${prefix}.png`, fullPage: true }).catch(() => {});
  await writeFile(`${prefix}.json`, JSON.stringify({ reason: safeReason, dom }, null, 2), 'utf8').catch(() => {});
  warn(`Saved failure artifacts for ${maskEmail(account.primaryEmail)} to ${prefix}.png/json`);
}

async function loginToOpenAI(page, account, authUrl) {
  info(`Opening codex-auth OAuth sign-in for ${maskEmail(account.primaryEmail)}`);
  await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
  info(`Primary page loaded: ${page.url()}`);

  await handleMaybeVisible(page, ['text=Log in to another account'], async (locator) => {
    await locator.click();
    info('Selected log in to another account');
  }, 5_000);

  await fillVisible(page, PRIMARY_EMAIL_SELECTORS, account.primaryEmail, 'primary email');

  await clickVisible(page, PRIMARY_SUBMIT_SELECTORS, 'next / sign in');
  info(`Primary page after email submit: ${page.url()}`);

  await preferMicrosoftPasswordIfPrompted(page);

  const passwordField = await waitForPasswordOrThrow(page);
  const passwordForCurrentProvider = /login\.live\.com|login\.microsoft\.com/i.test(page.url())
    ? account.emailPassword
    : account.servicePassword;
  await passwordField.fill(passwordForCurrentProvider);
  info('Filled primary password');

  await clickVisible(page, [...PRIMARY_SUBMIT_SELECTORS, 'button:has-text("Verify")'], 'password submit');
  info(`Primary page after password submit: ${page.url()}`);

  await bypassPasskeyIfPrompted(page);

  await handleMaybeVisible(page, FOCUS_PROMPT_SELECTORS, async (locator) => {
    const text = await locator.innerText().catch(() => '');
    await locator.click();
    info(text ? `Handled post-login prompt: ${text}` : 'Handled post-login prompt');
  });

  const postPasswordState = await waitAfterPasswordSubmit(page);
  info(`Primary page settled at: ${page.url()}`);

  if (postPasswordState === 'consent') {
    const locator = await waitForVisibleAny(page, ['button:has-text("Continue")'], DEFAULT_TIMEOUT);
    await locator.click();
    info('Accepted Codex consent');
  }

  await page.waitForURL(/localhost:\d+\/success/i, { timeout: DEFAULT_TIMEOUT });
  success(`OpenAI email/password flow completed for ${maskEmail(account.primaryEmail)}`);
}

async function waitAfterPasswordSubmit(page) {
  const deadline = Date.now() + DEFAULT_TIMEOUT;

  while (Date.now() < deadline) {
    const url = page.url();
    if (/localhost:\d+\/success/i.test(url)) return 'success';
    if (/sign-in-with-chatgpt\/codex\/consent/i.test(url)) return 'consent';

    const bodyText = await page.locator('body').innerText({ timeout: 1_000 }).catch(() => '');
    if (/incorrect email address or password|incorrect password|invalid password|sign-in failed|authentication error|IdentityProviderMismatch/i.test(bodyText)) {
      throw new Error(`OpenAI sign-in page reported a login failure: ${bodyText.replace(/\s+/g, ' ').slice(0, 180)}`);
    }

    await page.waitForTimeout(250);
  }

  throw new Error(`Timed out waiting for Codex consent or callback after password submit at ${page.url()}`);
}

async function waitForPasswordOrThrow(page) {
  const deadline = Date.now() + DEFAULT_TIMEOUT;
  let lastError;

  while (Date.now() < deadline) {
    for (const selector of PRIMARY_PASSWORD_SELECTORS) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.isVisible({ timeout: 250 })) {
          return locator;
        }
      } catch (err) {
        lastError = err;
      }
    }

    const bodyText = await page.locator('body').innerText({ timeout: 1_000 }).catch(() => '');
    if (/incorrect|try again|couldn't sign you in|account doesn't exist|invalid|session is no longer valid|authentication error|oops, an error occurred/i.test(bodyText)) {
      throw new Error(`OpenAI email step failed: ${bodyText.replace(/\s+/g, ' ').slice(0, 240)}`);
    }

    await page.waitForTimeout(250);
  }

  throw lastError ?? new Error('Timed out waiting for OpenAI password field');
}

async function runCodexAuthLogin(page, account) {
  info(`Starting local sync via codex-auth batch-login for ${maskEmail(account.primaryEmail)} from line ${account.lineNumber}`);
  const child = spawn('codex-auth', ['batch-login', ACCOUNTS_FILE, '--line', String(account.lineNumber)], {
    env: {
      ...process.env,
      BROWSER: 'true',
      PATH: `${NO_OPEN_BIN_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const authUrl = await waitForCodexAuthUrl(child, account.primaryEmail);
  info(`Captured codex-auth OAuth URL for ${maskEmail(account.primaryEmail)}`);
  try {
    await loginToOpenAI(page, account, authUrl);
    await waitForCodexAuthExit(child, account.primaryEmail);
  } catch (err) {
    child.kill('SIGTERM');
    throw err;
  }
  success(`Local sync completed for ${maskEmail(account.primaryEmail)}`);
}

async function runFallbackRecovery(context, fallbackEmail, fallbackEmailPassword, primaryEmail) {
  warn(`Starting fallback recovery for ${maskEmail(primaryEmail)} using ${maskEmail(fallbackEmail)}`);
  const recoveryPage = await context.newPage();

  try {
    await recoveryPage.goto(FALLBACK_URL, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
    info(`Fallback page loaded: ${recoveryPage.url()}`);

    await fillVisible(recoveryPage, FALLBACK_EMAIL_SELECTORS, fallbackEmail, 'fallback email');

    await clickVisible(recoveryPage, FALLBACK_SUBMIT_SELECTORS, 'fallback email submit');
    info(`Fallback page after email submit: ${recoveryPage.url()}`);

    const passwordField = await waitForVisibleAny(recoveryPage, FALLBACK_PASSWORD_SELECTORS);
    await passwordField.fill(fallbackEmailPassword);
    info('Filled fallback password');

    await clickVisible(recoveryPage, FALLBACK_SUBMIT_SELECTORS, 'fallback password submit');
    info(`Fallback page after password submit: ${recoveryPage.url()}`);

    await recoveryPage.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT }).catch(() => {});
    info(`Fallback page settled at: ${recoveryPage.url()}`);
    const bodyText = await recoveryPage.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    const fallbackFailurePattern = /incorrect|try again|failed|invalid|couldn't sign you in/i;
    if (fallbackFailurePattern.test(bodyText)) {
      throw new Error('Fallback mailbox sign-in reported a failure');
    }

    success(`Fallback recovery completed for ${maskEmail(fallbackEmail)}`);
  } finally {
    await recoveryPage.close().catch(() => {});
  }
}

async function connectToAccountChrome(chromium, account) {
  await mkdir(SESSION_DIR, { recursive: true });
  const profileDir = accountSessionDir(account);
  const port = await getAvailablePort(preferredChromeDebugPort(account));
  const chrome = spawn(CHROME_PATH, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], {
    stdio: 'ignore',
  });

  let browser;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  if (!browser) {
    chrome.kill('SIGTERM');
    throw new Error(`Unable to connect to Chrome over CDP on port ${port}`);
  }

  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.newPage();
  return {
    profileDir,
    context,
    page,
    async close() {
      await browser.close().catch(() => {});
      chrome.kill('SIGTERM');
    },
  };
}

async function processAccount(chromium, account) {
  const label = accountLabel(account);
  info(`Starting ${label}`);
  const startedAt = Date.now();

  const browserSession = await connectToAccountChrome(chromium, account);
  const { context, page, profileDir } = browserSession;
  info(`Created isolated Chrome profile for ${label}: ${profileDir}`);

  try {
    await runCodexAuthLogin(page, account);
    success(`Completed ${label}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(`Primary flow failed for ${label}: ${message}`);
    await captureFailureArtifacts(page, account, message);
    if (FALLBACK_RECOVERY) {
      try {
        await runFallbackRecovery(context, account.fallbackEmail, account.fallbackEmailPassword, account.primaryEmail);
      } catch (recoveryErr) {
        error(`Fallback recovery failed for ${label}: ${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`);
      }
    } else {
      warn(`Fallback recovery disabled; skipping fallback mailbox for ${label}`);
    }
    return false;
  } finally {
    await browserSession.close();
    info(`Closed isolated Chrome profile for ${label}`);
    info(`Finished ${label} in ${Date.now() - startedAt}ms`);
  }
}

async function processAccountsWithConcurrency(chromium, accounts) {
  let nextIndex = 0;
  let failureCount = 0;
  const workerCount = Math.min(CONCURRENCY, accounts.length);

  async function worker(workerIndex) {
    while (nextIndex < accounts.length && failureCount < MAX_FAILURES) {
      const account = accounts[nextIndex];
      nextIndex += 1;
      info(`Worker ${workerIndex + 1}/${workerCount} picked ${accountLabel(account)}`);
      const ok = await processAccount(chromium, account);
      if (!ok) {
        failureCount += 1;
        if (failureCount >= MAX_FAILURES) {
          error(`Stopping new work after ${failureCount} failure(s); --max-failures=${MAX_FAILURES}`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, index) => worker(index)));

  if (failureCount >= MAX_FAILURES) {
    process.exitCode = 1;
  }
}

async function main() {
  info(`Reading accounts from ${ACCOUNTS_FILE}`);

  let accounts;
  try {
    accounts = await readAccounts(ACCOUNTS_FILE);
  } catch (err) {
    error(`Unable to read accounts file: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  if (accounts.length === 0) {
    warn('No usable account records matched the requested file range.');
    return;
  }

  if (SKIP_EXISTING) {
    try {
      info('Checking codex-auth registry for already usable accounts');
      const registryEntries = await loadCodexAuthRegistry();
      const { selected, skipped } = filterExistingUsableAccounts(accounts, registryEntries);
      for (const { account, entry } of skipped) {
        info(`Skipping ${accountLabel(account)}; already listed with usable status: ${entry.statusText}`);
      }
      for (const account of selected) {
        const entry = registryEntries.get(account.primaryEmail.toLowerCase());
        if (entry) {
          warn(`Retrying ${accountLabel(account)}; existing registry status is unhealthy: ${entry.statusText}`);
        }
      }
      accounts = selected;
    } catch (err) {
      warn(`Unable to inspect codex-auth registry; continuing without skip-existing preflight: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    warn('Skip-existing preflight disabled; all matched accounts will run');
  }

  if (accounts.length === 0) {
    success('All matched accounts are already listed with usable status; nothing to run.');
    return;
  }

  if (DRY_RUN) {
    info('Dry-run mode enabled; browser and sync steps will be skipped');
    for (const [index, account] of accounts.entries()) {
      info(`Planned actions for ${maskEmail(account.primaryEmail)}:`);
      for (const action of buildPlannedActions(account, index)) {
        info(`  - ${action}`);
      }
    }
    return;
  }

  const { chromium } = await import('playwright');
  if (HEADLESS) {
    warn('HEADLESS=true is ignored for real Chrome CDP auth; Chrome launches visibly to avoid OpenAI fresh-profile 403s.');
  }
  info(`Chrome will launch one isolated real-browser profile per account over CDP; concurrency=${CONCURRENCY}`);
  if (CONCURRENCY > 1) {
    warn('Parallel mode starts multiple codex-auth children at once; use only when the local registry tolerates concurrent writes.');
  }

  await processAccountsWithConcurrency(chromium, accounts);
}

export {
  ACCOUNTS_FILE,
  FALLBACK_URL,
  FALLBACK_EMAIL_SELECTORS,
  FALLBACK_PASSWORD_SELECTORS,
  FALLBACK_SUBMIT_SELECTORS,
  FOCUS_PROMPT_SELECTORS,
  MICROSOFT_USE_PASSWORD_SELECTORS,
  PASSKEY_BYPASS_SELECTORS,
  PRIMARY_EMAIL_SELECTORS,
  PRIMARY_PASSWORD_SELECTORS,
  PRIMARY_SUBMIT_SELECTORS,
  buildPlannedActions,
  PRIMARY_URL,
  LINE_NUMBER,
  FROM_LINE_NUMBER,
  MAX_FAILURES,
  SKIP_EXISTING,
  CONCURRENCY,
  accountLabel,
  filterExistingUsableAccounts,
  isRegistryEntryUsable,
  parseCodexAuthList,
  parseCli,
  maskEmail,
  parseAccountLine,
  filterAccounts,
  readAccounts,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    error(`Unhandled failure: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exitCode = 1;
  });
}
