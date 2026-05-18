# codex-auto-login

Node.js Playwright automation for batch `codex-auth` login flows with one isolated real Chrome profile per account.

## Account File

Create a local `accounts.txt` file. Do not commit it.

```text
PrimaryEmail:ServicePassword:EmailPassword:FallbackEmail:FallbackEmailPassword
```

The parser expects exactly five colon-separated fields per non-empty line. Passwords containing `:` are intentionally rejected because that makes the row ambiguous.

## Usage

```sh
npm install
npm test
node auth-recovery-runner.mjs accounts.txt --dry-run
node auth-recovery-runner.mjs accounts.txt
```

Useful options:

```sh
node auth-recovery-runner.mjs accounts.txt --line 8
node auth-recovery-runner.mjs accounts.txt --from-line 2
node auth-recovery-runner.mjs accounts.txt --max-failures 1
node auth-recovery-runner.mjs accounts.txt --fallback-recovery
node auth-recovery-runner.mjs accounts.txt --no-skip-existing
```

## Behavior

- Starts `codex-auth batch-login <file> --line <source-line>`.
- Captures the OpenAI OAuth URL printed by `codex-auth`.
- Opens that URL in a dedicated Google Chrome user-data directory for that account.
- Uses the service password on OpenAI pages and the email password on Microsoft login pages.
- Clicks "Use your password" when Microsoft shows a passkey-first flow.
- Clicks the Codex consent "Continue" button when it appears.
- Saves screenshots and DOM snapshots under `auth-run-artifacts/` on failure.
- Runs `codex-auth list` before browser work and skips accounts already listed with usable status.
- Retries listed accounts when their registry status contains unhealthy markers like `401`, `token_expired`, `TimedOut`, `expired`, `error`, `failed`, or `invalid`.

## Local Requirements

- Node.js 20+ recommended.
- `codex-auth` available on `PATH`.
- Google Chrome installed at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, or set `CHROME_PATH`.

## Safety

Real account files, browser sessions, and failure artifacts are ignored by git. Keep `accounts.txt` and `accounts-next.txt` local only.
