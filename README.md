# NOVA CLI

<div align="center">

**An open-source, interactive command-line companion to [NOVA Mail](https://nova-email.com).**

Read, send, and manage your encrypted inbox right from the terminal — no passwords typed into a shell, ever.

`MIT License` · Zero runtime dependencies · Runs on **Node.js 18+**

</div>

---

## ✨ Features

- **Interactive menu** — run `nova` with no arguments for a full-screen, arrow-key TUI (Inbox · Read · Compose · Status · Log out). Long lists paginate with **PgUp/PgDn**, **Home/End**, and **1–9** quick-pick; prompts support **←/→** cursor editing.
- **Robust key input** — escape sequences are buffered and parsed per-token, so arrow keys keep working even when a terminal splits a sequence across network chunks (no accidental menu exits).
- **One-shot commands** — `nova mailbox`, `nova read`, `nova send`, `nova delete` for scripting.
- **Browser-based auth** — `nova login` opens your browser. After you sign in, NOVA sends a short-lived session token to `127.0.0.1` (your own machine) only.
- **Custom boot screen** — animated ASCII `NOVA` logo, clean interface, no bloat.
- **Auto-updating** — `nova update` checks for the latest build.
- **Optional AI bridge** — connect your *own* model provider (OpenAI, Anthropic, NVIDIA) to help draft replies. **Experimental · NOT recommended** (see below).
- **Open source** — fully auditable under the MIT License.

---

## 🚀 Install

> Prerequisite: [Node.js](https://nodejs.org) **18 or newer**.

### Windows

Download and run [`install.bat`](https://nova-email.com/cli/install.bat), then **open a new terminal** and run:

```bat
nova login
```

### macOS / Linux

```bash
curl -fsSL https://nova-email.com/cli/install.sh | bash
```

A `nova` command is symlinked into `~/.local/bin`, `~/bin`, or `/usr/local/bin`. Then:

```bash
nova login
```

### Or run it directly with just Node.js

```bash
node https://nova-email.com/cli/nova.mjs --help
```

### Or install from npm

```bash
npm install -g nova-mail-cli
nova --help
```

---

## 🕹️ Quick start

```bash
nova                # open the interactive menu
nova login          # sign in with your browser
nova mailbox        # list your inbox
nova read <id>      # read a message
nova send --to a@b.com --subject "Hi" --body "Hello"
nova delete <id>    # move a message to trash
nova status         # account + connection status
nova version        # show the CLI version
nova help           # full help
```

---

## 🤖 AI agent (EXPERIMENTAL · NOT RECOMMENDED)

> ⚠ **NOVA itself never runs or trains any AI model.** Your mail is never used to train anything.
> What this does is let **you** connect **your own** model provider (OpenAI / Anthropic / NVIDIA)
> so a model can *help draft* replies. Drafts are held for your approval unless you explicitly
> enable auto-approve.
>
> **Use at your own risk.** An AI agent can make mistakes, fabricate content, or send mail you
> did not intend. Treat everything it produces as a suggestion, review it, and keep auto-approve OFF.

```bash
nova ai setup       # choose a provider and enter your API key
nova ai test        # verify your provider key
nova ai prompt      # print the master prompt for your agent
nova ai curl        # print a ready-to-run curl connect command
```

Your API key is stored in a local config file (`~/.nova/config.json`) and is never uploaded
anywhere — it's only used to call the provider's API from your machine.

Supported providers:

| Provider | Env / CLI | Default model |
|----------|-----------|---------------|
| OpenAI   | `nova ai setup` | `gpt-4o-mini` |
| Anthropic | `nova ai setup` | `claude-3-5-haiku-latest` |
| NVIDIA (build.nvidia.com) | `nova ai setup` | `meta/llama-3.1-8b-instruct` |

---

## 🔒 Security

- **Auth** — you never type a password into the terminal. The session token is delivered to
  `http://127.0.0.1:<port>` on your machine only.
- **Stored config** — session token and any API keys live in `~/.nova/config.json` on your disk,
  with restrictive intent. Delete the file to sign out fully.
- **No telemetry** — the CLI makes no calls other than to NOVA's own API and your chosen provider.
- **Open source** — read the code; there are no hidden network calls.

---

## 📁 Configuration

Config file: `~/.nova/config.json`

```json
{
  "token": "...",
  "email": "you@nova-email.com",
  "base": "https://nova-email.com",
  "ai": { "provider": "openai", "key": "..." }
}
```

You can point the CLI at a self-hosted NOVA instance with `--base <url>`.

---

## 🧑‍💻 Contributing

PRs, issues, and ideas are welcome. Keep it dependency-free where you can, and document everything.

1. Fork & clone.
2. `node bin/nova.mjs --help`
3. Make your change and add a test if practical.
4. Open a pull request.

---

## 🛡️ License

[MIT](./LICENSE) — Copyright (c) 2026 Gc1dk (a.k.a. Gc.idk). See `LICENSE` for details.
