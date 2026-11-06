# notecli

An unofficial, agent-friendly CLI for managing [note.com](https://note.com) articles.

日本語の概要は [README.ja.md](./README.ja.md) を参照してください。

`notecli` uses note.com's internal API with your browser session cookies. It is designed for
scripting and AI agents: JSON is emitted automatically when stdout is not a TTY, article bodies
can be read from stdin, errors are machine-readable, and cookie values are never printed.

> **Disclaimer:** This project is not affiliated with note.com. It uses an unofficial API that
> may change or stop working without notice. Use it at your own risk and follow note.com's terms.

## Features

- Authenticate with a Cookie header, a cookie file, `.env`, or a stored credentials file
- List, get, create, update, publish, and delete articles
- Convert Markdown to note.com-compatible HTML (element UUIDs, lists, code blocks, images,
  blockquote citations, TOC, text alignment, embeds, stock notation)
- Convert note.com HTML back to Markdown for editing
- Upload body images and eyecatch images
- Create preview URLs for drafts
- Agent-friendly JSON output and stable exit codes
- Cookie rotation from `Set-Cookie` responses
- Credentials file written with owner-only permissions (`0600`)

## Requirements

- Node.js 20 or newer
- A note.com account

## Install

```bash
git clone <this-repository>
cd notecli
pnpm install
pnpm build
pnpm notecli --version
```

Run commands through pnpm from the repository:

```bash
pnpm notecli auth status --json
```

For scripts and AI agents, use `--silent` so pnpm's own status messages do not mix with
the CLI's JSON:

```bash
pnpm --silent notecli auth status --json
# short form
pnpm -s notecli list --status draft --json
```

The CLI preserves its exit code through pnpm (for example, `3` when not authenticated).

Alternatively, run the local wrapper directly:

```bash
./bin/notecli --version
# or
export PATH="$PWD/bin:$PATH"
notecli --version
```

The wrapper uses the local `dist/` build, so run `pnpm build` after changing the source.

Optional global install:

```bash
npm install -g .
```

`npm` installs into the active Node prefix, which is usually already on `PATH`.
`pnpm link --global` may fail when pnpm's global bin directory
(`~/Library/pnpm/bin` on macOS) is not on `PATH`; in that case use pnpm scripts or the local
wrapper above.

## Authentication

`notecli` never performs a browser login. It needs the `_note_session_v5` cookie and preferably
the `XSRF-TOKEN` cookie from a logged-in browser session.

### 1. Environment variable (recommended for agents)

`notecli` automatically loads `.env` from the current working directory (Node 20.12+).
Shell environment variables take precedence over `.env`.

```bash
# .env (gitignored; chmod 600)
NOTE_COOKIE='_note_session_v5=...; XSRF-TOKEN=...'
```

```bash
pnpm -s notecli auth status --json
```

`NOTE_COOKIE` accepts:

- a raw Cookie header: `_note_session_v5=...; XSRF-TOKEN=...`
- a JSON object: `{"_note_session_v5":"...","XSRF-TOKEN":"..."}`
- a JSON array of `{ "name": "...", "value": "..." }` objects (Playwright export)
- a `{ "cookies": ... }` wrapper around either JSON form
- a Netscape `cookies.txt` file

### 2. Cookie file

```bash
export NOTE_COOKIE_FILE="$HOME/.note-cookies"
pnpm -s notecli auth status
```

The file can use any of the formats above. Keep it private (`chmod 600`).

### 3. Stored credentials file

```bash
notecli auth set-cookie --file "$HOME/.note-cookies"
# or paste when prompted:
notecli auth set-cookie
# or pass the Cookie header as an argument:
notecli auth set-cookie '_note_session_v5=...; XSRF-TOKEN=...'
```

`auth login` is kept as an alias of `auth set-cookie`.

Credentials are stored in `~/.config/notecli/credentials.json` with mode `0600`.
Set `NOTE_CONFIG_DIR` or `XDG_CONFIG_HOME` to change the location.

### How to copy cookies from Chrome / Edge

1. Open <https://note.com> and log in.
2. Open DevTools → **Application** → **Cookies** → `https://note.com`.
3. Copy the full Cookie header, including:
   - `_note_session_v5` (the session cookie; it is HttpOnly, so `document.cookie` will not show it)
   - `XSRF-TOKEN` if present
   - `note_gql_auth_token` if present
4. Build a header: `_note_session_v5=...; XSRF-TOKEN=...; note_gql_auth_token=...`

A browser extension that exports Netscape `cookies.txt` also works with `NOTE_COOKIE_FILE` or
`notecli auth set-cookie --file`.

### Authentication precedence

1. `NOTE_COOKIE`
2. `NOTE_COOKIE_FILE`
3. `~/.config/notecli/credentials.json` (or `NOTE_CONFIG_DIR/credentials.json`)

`notecli auth status` reports the source and verifies the session. `notecli auth logout` (or
`auth clear-cookie`) removes only the stored file; environment variables are unaffected.

## Commands

In the examples below, `notecli` means `pnpm -s notecli` when running from this repository.

```text
notecli auth set-cookie [cookie] [--file <path>] [--cookie-file <path>] [--session <value>] [--xsrf <token>] [--no-verify]
notecli auth status
notecli auth logout

notecli list [--status draft|published|private|all] [--page N] [--limit N]
notecli get <key> [--html] [--body-only]
notecli create --title <title> [--body <markdown>] [--file <path>] [--stdin] [--tag <tag> ...] [--tags a,b] [--publish]
notecli update <key> [--title <title>] [--body <markdown>] [--file <path>] [--stdin] [--tag <tag> ...] [--tags a,b]
notecli publish <key> [--tag <tag> ...] [--tags a,b]
notecli delete <key> [--yes]
notecli preview <key> [--open]
notecli image <key> <file> [--eyecatch]
```

Use `--json` (or rely on non-TTY stdout) for machine-readable output, and `--format text` to force
human-readable output.

note.com does not return draft tags through the API. Pass `--tags` explicitly when publishing a
draft (or use `create --publish --tags ...`) so the tags are applied at publish time.

### Examples

```bash
# List drafts
notecli list --status draft --limit 20

# Read an article as Markdown (--body-only is useful for piping)
notecli get n1234567890ab --format text --body-only

# Create a draft from stdin
printf '# Title\n\nHello **note**!\n' | notecli create --title "Hello" --json

# Create and publish
notecli create --title "Release notes" --file article.md --publish --tags release,note

# Update only the title (the body is preserved untouched)
notecli update n1234567890ab --title "New title"

# Replace the body from stdin
notecli update n1234567890ab --stdin < article.md

# Publish an existing draft and set tags
notecli publish n1234567890ab --tags release,note

# Create a preview URL
notecli preview n1234567890ab --json

# Upload a body image; the JSON result contains a ready-to-paste Markdown snippet
notecli image n1234567890ab ./diagram.png

# Upload an eyecatch image
notecli image n1234567890ab ./header.png --eyecatch

# Delete a draft (required because the command is non-interactive)
notecli delete n1234567890ab --yes
```

## Markdown support

The converter intentionally follows note.com's editor format. Supported features include:

- CommonMark headings, paragraphs, emphasis, links, lists, code blocks, and images
- `[TOC]` on its own line → note.com table-of-contents element (the first occurrence only)
- `> quote` with a citation line `> — Source (https://example.com)` → blockquote figure and caption
- `->centered<-`, `->right`, `<-left` → aligned paragraphs
- Standalone supported URLs → embeds (YouTube, X/Twitter, note.com, GitHub, Gist, Google Slides,
  SpeakerDeck, note money, Zenn, Qiita, connpass)
- `^5243` and `$GOOG` stock notation → note money links
- Images become note.com `<figure>` elements with a `figcaption` from the Markdown title
- KaTeX math such as `$${a^2 + b^2 = c^2}$$` is passed through for note.com to render

See `src/lib/markdown-to-html.ts` for the exact transformations.

## Agent contract

See [AGENTS.md](./AGENTS.md) for a compact command contract. Key points:

- When stdout is not a TTY, output is JSON. You can also pass `--json`.
- Successful JSON goes to stdout. Errors go to stderr as
  `{"error":{"code","message",...}}`.
- Exit codes: `0` success, `2` usage, `3` auth, `4` not found, `5` rate limited, `6` API,
  `7` invalid input.
- Use `--stdin` or `--body -` for article bodies. `create` also reads piped stdin automatically.
- `delete` requires `--yes` when stdin is not a TTY.
- Cookie values are never included in output.

Example JSON shapes:

```json
{
  "articles": [
    { "id": "123", "key": "n123abc", "title": "Hello", "status": "draft", "tags": [] }
  ],
  "total": 1,
  "page": 1,
  "has_more": false
}
```

```json
{
  "article": {
    "id": "123",
    "key": "n123abc",
    "title": "Hello",
    "status": "draft",
    "tags": ["note"],
    "body": "# Hello\n\nWorld\n",
    "body_html": "<h1 ...>Hello</h1>..."
  },
  "published": false,
  "warnings": []
}
```

## Security

- Cookie values are never printed, including by `auth status` and `--verbose`.
- Cookie files exported from a browser are filtered to `note.com` domains when their format
  includes a domain column; unrelated cookies are not sent to note.com.
- The stored credentials file is created with `0600` (directory `0700`).
- Environment variables take precedence over the file, so agents can inject secrets without
  writing them to disk.
- `_note_session_v5` is HttpOnly; copy it from DevTools or a cookie export, not `document.cookie`.
- Prefer `NOTE_COOKIE`/`NOTE_COOKIE_FILE` over `--cookie` on shared machines: command-line
  arguments may appear in shell history and process listings.
- The API is unofficial and rate-limited. Respect note.com's terms and avoid excessive requests.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Project layout:

```text
src/cli.ts                 CLI entry point and command registration
src/commands/              auth and article commands
src/lib/api.ts             authenticated HTTP client
src/lib/articles.ts        article models and parsing
src/lib/note-api.ts        high-level article/image operations
src/lib/cookies.ts         cookie parsing and rotation
src/lib/config.ts          credential precedence and secure storage
src/lib/markdown-to-html.ts  note.com HTML generation
src/lib/html-to-markdown.ts  note.com HTML → Markdown
src/lib/embeds.ts          embed detection and key registration
```

## License

MIT
