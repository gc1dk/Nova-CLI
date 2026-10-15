# NOVA CLI — AI Agent Guide

> ⚠ **EXPERIMENTAL · NOT RECOMMENDED.**
>
> NOVA itself runs **no** AI and never reads or trains on your mail. This feature is a
> **BYO (bring-your-own) agent** bridge: you connect *your own* model provider so an AI can
> help you draft replies against your own inbox. Use at your own risk.

---

## How it works

1. You (or your agent) talk to NOVA's **AI bridge API** (`/api/ai`) with a dedicated,
   revocable **AI token** that you generate in the NOVA web app (**AI Email** panel).
2. The bridge lets the agent list/read your mail and submit drafts.
3. Drafts are **held for manual approval** unless you explicitly enable **auto-approve**.
4. Separately, the CLI can call your **own model provider** (OpenAI, Anthropic, NVIDIA) to
   *generate* a draft for you — it never sends anything by itself.

The AI never has your password. It only ever sees what you let it through the bridge.

---

## 1. Configure a provider

```bash
nova ai setup
```

Choose a provider and paste your API key. Your key is stored **encrypted at rest**
(AES-256-GCM) in `~/.nova/config.json` and is only used to call the provider from your machine —
it is **never uploaded to NOVA**.

### Verify your key

```bash
nova ai test
```

---

## 2. Generate a master prompt

```bash
nova ai prompt
```

This prints a ready-to-paste prompt that tells your agent:

- the API base URL,
- to send `x-ai-token: <token>` on every request,
- how to list mail, read mail, and submit drafts,
- strict rules (never fabricate a recipient, prefer drafts over auto-send).

### Get a curl connect command

```bash
nova ai curl openai
nova ai curl anthropic
nova ai curl nvidia
```

---

## 3. Generate your AI token + enable the bridge

The **AI token** is created in the **NOVA web app** under **AI Email**:

1. Open `https://nova-email.com/ai` (signed in).
2. Click **Enable AI Email**.
3. Click **Generate AI token** and copy it (shown once).
4. Paste it into your agent as the `x-ai-token` value (or into the master prompt).

> The AI token is separate from your session token and can be **revoked instantly**
> (disable the bridge). When the bridge is disabled, the token stops working immediately.

---

## 4. Drafting vs sending

| Setting | Behavior |
|---------|----------|
| **Manual approval (default)** | AI drafts are held in a queue; **you** approve/reject each one. |
| **Auto-approve ON** | AI drafts send immediately. **Riskier — use only if you fully trust the agent.** |

Keep auto-approve **OFF** unless you really need it. You can toggle it in the NOVA web app
(AI Email panel) or from the CLI's AI menu.

---

## Providers

| Provider | Base URL | Notes |
|----------|----------|-------|
| OpenAI | `https://api.openai.com/v1` | Default `gpt-4o-mini` |
| Anthropic | `https://api.anthropic.com/v1` | Default `claude-3-5-haiku-latest` |
| NVIDIA | `https://integrate.api.nvidia.com/v1` | build.nvidia.com; default `meta/llama-3.1-8b-instruct` |

---

## Disabling the AI bridge

You can turn the bridge off at any time, which **instantly revokes** the AI token:

- In the NOVA web app: **AI Email** panel → **Disable immediately**.
- From the CLI: run `nova` → **AI agent** → **Disable the AI bridge**.

---

## Safety checklist

- [ ] Keep **auto-approve OFF** unless necessary.
- [ ] Review every draft before approving.
- [ ] Treat the master prompt as minimum guardrails — add your own constraints.
- [ ] Revoke the token if you stop using the agent.
