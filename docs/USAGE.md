# NOVA CLI — Usage Guide

Everything the CLI can do, in one place.

## Interactive menu

Run `nova` with no arguments to open the full-screen menu:

```
📥  Inbox (list messages)
✉️   Read a message
📤  Compose & send
🔎  Search
📁  Folders
🤖  AI agent (experimental, NOT recommended)
📊  Status
🚪  Log out
❌  Exit
```

- **↑ / ↓** move, **Enter** selects.
- **PgUp / PgDn** or **Home / End** jump within a long list.
- **1–9** quick-pick the Nth visible item.
- **q / Esc** goes back a level.
- **Ctrl-C** quits.

### Line prompts
When typing (e.g. To / Subject / Body, or an AI key), the prompt supports full editing:
**← / →** move the cursor, **Home / End** jump, **Backspace / Delete** remove,
and artifacts from arrow keys no longer leak into your input.

### Inbox
Lists your latest messages with sender, unread indicator and time. Pick one to read it.

### Read
Type a message id (or paste the short id shown in the inbox list) to open the full body.

### Compose & send
Walk through To / Subject / Body. An empty line finishes the body.

---

## One-shot commands (for scripting)

```bash
nova login                        # browser-based sign-in
nova logout                       # clear the saved session
nova mailbox                      # list inbox
nova mailbox "Project"            # list a specific folder
nova read <id>                    # show a message (marks it read)
nova read <id> --no-mark-read     # show without marking read
nova send --to a@b.com --subject "Hi" --body "Hello"
nova send --to a@b.com -s "Hi" --body-file draft.txt
nova send --to a@b.com -s "Hi" --body-file -   # body from stdin
nova search "invoice"             # search messages
nova folders                      # list folders + unread counts
nova mark <id> star               # read | unread | star | unstar
nova move <id> archive            # move a message to a folder
nova delete <id>                  # move to trash
nova delete <id> --permanent      # delete for good
nova status                       # account + connection
nova whoami                       # signed-in account details
nova version                      # version
nova update                       # check for the latest build
nova help                         # full help
```

## Global options

- `--base <url>` — point at a custom/self-hosted NOVA instance.
- `--limit <n>` — rows for `mailbox` / `search` (default 25).
- `--all` — fetch every page (`mailbox`).
- `--json` — machine-readable output (`mailbox`, `folders`, `read`, `search`, `status`, `whoami`).
- `--body-file <path>` — read the `send` body from a file (`-` = stdin).
- `--no-color` — disable ANSI colors.

---

## Exit codes

- `0` — success
- `1` — error (bad usage, auth failure, network/API failure)

---

## Where your data is stored

- `~/.nova/config.json` — non-secret settings (`base`, `email`, AI provider) plus **encrypted
  secrets** (session token, AI provider key) as a `secrets` field, encrypted with AES-256-GCM.
- `~/.nova/key` — the random 256-bit key that decrypts those secrets (owner-only, `0600`).

Delete **both** files to fully sign out and clear stored credentials locally. Plaintext `token` /
`ai.key` values from older versions are migrated into the encrypted `secrets` field automatically.
