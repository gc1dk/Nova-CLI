# NOVA CLI — Usage Guide

Everything the CLI can do, in one place.

## Interactive menu

Run `nova` with no arguments to open the full-screen menu:

```
📥  Inbox (list messages)
✉️   Read a message
📤  Compose & send
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
nova login                       # browser-based sign-in
nova logout                      # clear the saved session
nova mailbox                     # list inbox
nova mailbox "Project"           # list a specific folder
nova read <id>                   # show a message
nova send --to a@b.com --subject "Hi" --body "Hello"
nova send --to a,b@c.com -s "Hi" -m "body"
nova delete <id>                 # move to trash
nova status                      # account + connection
nova version                     # version
nova update                      # check for the latest build
nova help                        # full help
```

## Global options

- `--base <url>` — point at a custom/self-hosted NOVA instance.
- `--no-color` — disable ANSI colors.

---

## Exit codes

- `0` — success
- `1` — error (bad usage, auth failure, network/API failure)

---

## Where your data is stored

- Config + session + (optional) AI key: `~/.nova/config.json`

Delete that file to fully sign out and clear stored credentials locally.
