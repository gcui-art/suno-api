# Suno Cookie Extractor

A small tool that logs into [suno.com](https://suno.com) and grabs the `SUNO_COOKIE` value your suno-api server needs.

## What it does

1. Opens `suno.com/create` in a browser
2. Signs you in (automatically or manually)
3. Captures the cookie from Clerk API requests
4. Prints the cookie and optionally saves it to the project `.env`

## Quick start

From the **project root**:

```bash
npm run get-cookie -- --save
```

Or from **this folder**:

```bash
npm install   # first time only
npm start -- --save
```

The `--save` flag writes `SUNO_COOKIE` to `../.env` (the main app config file).

## Step by step

1. **Run the tool** — a browser window opens to Suno.
2. **Sign in** — either:
   - Use `--manual` to sign in yourself in the browser (best for Google/Apple SSO or 2FA), or
   - Enter your email/password when prompted, or
   - Pass credentials on the command line (see below), or
   - Log in manually in the browser if automation fails.
3. **Wait** — the script listens for the Clerk cookie and prints it when ready.
4. **Save** — use `--save` to update `.env` automatically, or copy the printed value yourself.

## Options

| Flag | Description |
|------|-------------|
| `-s`, `--save` | Write `SUNO_COOKIE` to the project `.env` (default) |
| `-m`, `--manual` | Manual sign-in only — skips email/password prompts; use for Google/Apple SSO or 2FA |
| `-e`, `--email` | Suno account email |
| `-p`, `--password` | Suno account password |
| `--headless` | Run without a visible browser window |
| `--timeout <sec>` | Max wait time (default: 300) |
| `-h`, `--help` | Show help |

You can also set `SUNO_EMAIL`, `SUNO_PASSWORD`, and `SUNO_MANUAL=1` as environment variables instead of using flags.

## Examples

```bash
# Interactive — prompts for credentials, prints cookie only
npm run get-cookie

# Save directly to .env
npm run get-cookie -- --save

# Manual sign-in in the browser (Google/Apple SSO, 2FA)
npm run get-cookie -- --manual --save

# Pass credentials on the command line
npm run get-cookie -- --email you@example.com --password yourpassword --save

# Use env vars (password stays out of shell history)
SUNO_EMAIL=you@example.com SUNO_PASSWORD=secret npm run get-cookie -- --save
```

## Verify it worked

After saving, start the API server and check your quota:

```bash
npm run dev
curl http://localhost:3000/api/get_limit
```

You should get a JSON response with `credits_left` — not an auth error.

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| Timed out waiting for cookie | Make sure you finished signing in. Run again and complete login in the browser. |
| Automated sign-in failed | Re-run with `--manual` and sign in yourself (Google/Apple SSO is fine). The script waits and captures the cookie when you're done. |
| Cookie saved but API fails | Cookies expire. Re-run with `--save` to refresh. |
| Browser doesn't open | Install deps: `cd suno-cookie-extractor && npm install` |

## Notes

- Cookies expire periodically — re-run this tool when the API starts returning auth errors.
- Treat your cookie like a password. Do not commit `.env` or share the value.
- This follows the manual steps from the [suno-api README](https://github.com/gcui-art/suno-api#1-obtain-the-cookie-of-your-suno-account).