#!/usr/bin/env node
/**
 * NOVA Mail CLI — https://github.com/gc1dk/Nova-CLI
 * A command-line companion to NOVA Mail (https://nova-email.com).
 *
 * MIT License · Copyright (c) 2026 Gc1dk (a.k.a. Gc.idk)
 *
 * Zero runtime dependencies. Runs on Node.js 18+.
 *
 * Auth: browser-based. `nova login` opens your browser so you can sign in;
 * NOVA redirects back to a loopback port with a short-lived session token.
 * The token is only ever sent to 127.0.0.1 (your own machine).
 *
 * Run `nova` with no arguments for the interactive menu, or use one-shot
 * commands below for scripting.
 */

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

/* ------------------------------------------------------------------ *
 *  Constants
 * ------------------------------------------------------------------ */
const APP_NAME = "NOVA Mail";
const DEFAULT_BASE = "https://nova-email.com";
const VERSION = "0.3.0";
const REPO = "https://github.com/gc1dk/Nova-CLI";
const CONFIG_DIR = path.join(os.homedir(), ".nova");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// AI providers the CLI knows how to talk to.
const AI_PROVIDERS = {
  openai: {
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    auth: "Authorization: Bearer <KEY>",
  },
  anthropic: {
    label: "Anthropic",
    base: "https://api.anthropic.com/v1",
    model: "claude-3-5-haiku-latest",
    auth: "x-api-key: <KEY>",
  },
  nvidia: {
    label: "NVIDIA (build.nvidia.com)",
    base: "https://integrate.api.nvidia.com/v1",
    model: "meta/llama-3.1-8b-instruct",
    auth: "Authorization: Bearer <KEY>",
  },
};

/* ------------------------------------------------------------------ *
 *  Output helpers (clean interface, ANSI, no deps)
 * ------------------------------------------------------------------ */
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};
const usesColor = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(s, code) {
  return usesColor ? `${code}${s}${c.reset}` : s;
}
const bold = (s) => paint(s, c.bold);
const dim = (s) => paint(s, c.dim);
const red = (s) => paint(s, c.red);
const green = (s) => paint(s, c.green);
const yellow = (s) => paint(s, c.yellow);
const cyan = (s) => paint(s, c.cyan);
const magenta = (s) => paint(s, c.magenta);

const KEY = paint("N", c.cyan) + paint("O", c.magenta) + paint("V", c.green) + paint("A", c.yellow);

const LOGO = `
    ███╗   ██╗ ██████╗ ██╗   ██╗ █████╗
    ████╗  ██║██╔═══██╗██║   ██║██╔══██╗
    ██╔██╗ ██║██║   ██║██║   ██║███████║
    ██║╚██╗██║██║   ██║╚██╗ ██╔╝██╔══██║
    ██║ ╚████║╚██████╔╝ ╚████╔╝ ██║  ██║
    ╚═╝  ╚═══╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝`;

const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function log(...args) {
  process.stdout.write(args.join(" ") + "\n");
}

function err(msg) {
  log(red(bold("✖ ")) + red(msg));
  process.exitCode = 1;
}

// Consistent "not recommended / experimental" banner for anything AI.
function aiBanner() {
  log(yellow(bold("  ⚠ EXPERIMENTAL · NOT RECOMMENDED")));
  log(dim("  AI access is a BYO-agent bridge. NOVA itself runs no AI and never") +
       dim("  reads/trains on your mail. Use at your own risk; an AI agent can make") +
       dim("  mistakes and send mail you did not intend."));
  log("");
}

/* ------------------------------------------------------------------ *
 *  Config
 * ------------------------------------------------------------------ */
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function saveAuth(token, email) {
  const cfg = readConfig();
  if (token) cfg.token = token;
  if (email) cfg.email = email;
  if (!cfg.base) cfg.base = DEFAULT_BASE;
  writeConfig(cfg);
}
function clearAuth() {
  const cfg = readConfig();
  delete cfg.token;
  delete cfg.email;
  writeConfig(cfg);
}

/* ------------------------------------------------------------------ *
 *  Network helpers
 * ------------------------------------------------------------------ */
async function api(pathname, { method = "GET", body, token } = {}) {
  const cfg = readConfig();
  const base = (cfg.base || DEFAULT_BASE).replace(/\/$/, "");
  const headers = { Accept: "application/json" };
  if (token || cfg.token) headers.Authorization = `Bearer ${token || cfg.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}/api/mailbox${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

/* ------------------------------------------------------------------ *
 *  Spinner (async animation)
 * ------------------------------------------------------------------ */
async function withSpinner(label, fn) {
  if (!process.stdout.isTTY) return fn();
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${cyan(spinners[i++ % spinners.length])} ${dim(label)}...`);
  }, 80);
  try {
    const out = await fn();
    process.stdout.write(`\r${green("✓")} ${label}\n`);
    return out;
  } catch (e) {
    process.stdout.write(`\r${red("✖")} ${label}\n`);
    throw e;
  } finally {
    clearInterval(timer);
  }
}

/* ------------------------------------------------------------------ *
 *  Interactive input (raw mode TUI, zero deps)
 * ------------------------------------------------------------------ */
function enableRaw() {
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    return true;
  } catch {
    return false;
  }
}
function disableRaw() {
  try {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  } catch {
    /* ignore */
  }
}

// ----------------------------------------------------------------------
// Chunk-safe raw-mode input. Terminals may split an escape sequence
// across multiple data chunks (and may send SS3/Csi sequences), so we
// buffer input and parse whole key tokens from the stream rather than
// reading byte-by-byte from a single chunk.
// ----------------------------------------------------------------------

const SS3_MAP = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const CSI_MAP = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const CSI_TILDE_MAP = { 1: "home", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end" };

// Consume one key token from the front of `buf`.
// Returns { key, len } or null when more bytes are needed.
function parseKey(buf) {
  if (!buf) return null;
  const c = buf[0];
  if (c === "\u0003") return { key: "ctrl-c", len: 1 };
  if (c === "\r" || c === "\n") return { key: "enter", len: 1 };
  if (c === "\u007f" || c === "\b") return { key: "backspace", len: 1 };
  if (c >= " ") {
    const cp = buf.codePointAt(0);
    const ch = String.fromCodePoint(cp);
    return { key: ch, len: ch.length };
  }
  if (c !== "\u001b") return { key: null, len: 1 }; // swallow stray control bytes
  if (buf.length === 1) return null; // bare ESC — ambiguous, wait for more
  if (buf[1] === "O") {
    if (buf.length < 3) return null;
    const k = SS3_MAP[buf[2]];
    return { key: k || null, len: 3 };
  }
  if (buf[1] === "[") {
    let j = 2;
    while (j < buf.length && (buf[j] >= "0" && buf[j] <= "9" || buf[j] === ";" || buf[j] === ":")) j++;
    if (j >= buf.length) return null; // CSI unterminated — wait for final byte
    const fin = buf[j];
    const n = Number.parseInt(buf.slice(2, j), 10);
    let key = CSI_MAP[fin];
    if (!key && fin === "~") key = CSI_TILDE_MAP[Number.isNaN(n) ? 0 : n];
    return { key: key || null, len: j + 1 };
  }
  return { key: null, len: 2 }; // ESC + other (Alt+key) — swallow
}

// A streaming key source that stays subscribed until close().
function keyStream() {
  let buf = "";
  let queue = [];
  let waiters = [];
  let timer = null;
  const deliver = (key) => {
    const w = waiters.shift();
    if (w) w(key);
    else queue.push(key);
  };
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    for (;;) {
      const t = parseKey(buf);
      if (!t) break;
      buf = buf.slice(t.len);
      if (t.key !== null) deliver(t.key);
    }
    // A lone ESC could be a real Esc press or the start of a sequence that
    // hasn't arrived yet — disambiguate with a short delay.
    if (buf === "\u001b") {
      timer = setTimeout(() => {
        timer = null;
        buf = "";
        deliver("\u001b");
      }, 60);
    }
  };
  const onData = (d) => {
    buf += d;
    flush();
  };
  process.stdin.on("data", onData);
  return {
    next() {
      return new Promise((res) => {
        if (queue.length) { res(queue.shift()); return; }
        waiters.push(res);
        flush();
      });
    },
    close() {
      process.stdin.off("data", onData);
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}

// Read a single line. opts.echo masks input (e.g. API keys).
function readLine(prompt, opts = {}) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      process.stdout.write(prompt);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.once("data", (d) => resolve(String(d).replace(/[\r\n]+$/, "")));
      return;
    }
    enableRaw();
    let buf = "";
    let cur = 0;
    const shown = () => (opts.echo ? opts.echo(buf) : buf);
    const render = () => {
      const s = shown();
      process.stdout.write("\r" + prompt + s + (s.length ? " " : "") + "\x1b[K");
      const col = (opts.echo ? opts.echo(buf.slice(0, cur)) : buf.slice(0, cur)).length;
      process.stdout.write("\x1b[" + Math.max(0, s.length - col + 1) + "D");
    };
    render();
    const ks = keyStream();
    (async () => {
      for (;;) {
        const k = await ks.next();
        if (k === "ctrl-c") { ks.close(); disableRaw(); process.stdout.write("\n"); process.exit(1); }
        if (k === "enter") {
          ks.close();
          disableRaw();
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (k === "backspace") {
          if (cur > 0) { buf = buf.slice(0, cur - 1) + buf.slice(cur); cur--; render(); }
          continue;
        }
        if (k === "delete") {
          if (cur < buf.length) { buf = buf.slice(0, cur) + buf.slice(cur + 1); render(); }
          continue;
        }
        if (k === "left") { if (cur > 0) { cur--; render(); } continue; }
        if (k === "right") { if (cur < buf.length) { cur++; render(); } continue; }
        if (k === "home") { cur = 0; render(); continue; }
        if (k === "end") { cur = buf.length; render(); continue; }
        if (typeof k === "string" && k.length === 1 && k >= " ") {
          buf = buf.slice(0, cur) + k + buf.slice(cur);
          cur++;
          render();
          continue;
        }
      }
    })();
  });
}

function readKey() {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(""); return; }
    enableRaw();
    const ks = keyStream();
    ks.next().then((k) => {
      ks.close();
      disableRaw();
      resolve(typeof k === "string" ? k : "");
    });
  });
}

// Arrow-key list selector. Returns index, or -1 if cancelled (q/Esc).
function choose(items, prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(0);
      return;
    }
    let idx = 0;
    const pageSize = Math.max(6, (process.stdout.rows || 24) - 8);
    const top = () => Math.max(0, Math.min(idx - 2, Math.max(0, items.length - pageSize)));
    const draw = () => {
      process.stdout.write("\x1b[2J\x1b[H");
      bootScreen(prompt || "Select an option");
      const lo = top();
      const list = items.slice(lo, lo + pageSize);
      list.forEach((item, i) => {
        if (lo + i === idx) log("  " + paint("› ", c.cyan) + "  " + paint(item, c.bold));
        else log("    " + item);
      });
      log("");
      const nav = "  ↑/↓ navigate · Enter select · q/Esc back · Ctrl-C quit";
      const paged = items.length > pageSize ? " · PgUp/PgDn page · 1-9 quick pick" : "";
      log(dim(nav + paged));
    };
    enableRaw();
    draw();
    const ks = keyStream();
    const done = (v) => {
      ks.close();
      disableRaw();
      process.stdout.write("\x1b[2J\x1b[H");
      resolve(v);
    };
    (async () => {
      for (;;) {
        const k = await ks.next();
        if (k === "ctrl-c") { disableRaw(); process.stdout.write("\n"); process.exit(1); }
        if (k === "enter") { done(idx); return; }
        const n = items.length;
        if (k === "up") { idx = (idx - 1 + n) % n; draw(); continue; }
        if (k === "down") { idx = (idx + 1) % n; draw(); continue; }
        if (k === "pageup" || k === "home") { idx = Math.max(0, idx - pageSize); draw(); continue; }
        if (k === "pagedown" || k === "end") { idx = Math.min(n - 1, idx + pageSize); draw(); continue; }
        if (/^[1-9]$/.test(k)) {
          const t = top();
          if (t + Number(k) - 1 < n) { idx = t + Number(k) - 1; draw(); }
          continue;
        }
        if (k === "q" || k === "Q" || k === "\u001b") { done(-1); return; }
      }
    })();
  });
}

function pauseScreen(msg = "Press any key to continue") {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { process.stdout.write("\n"); resolve(); return; }
    enableRaw();
    process.stdout.write("\n  " + dim(msg) + "  ");
    const ks = keyStream();
    ks.next().then(() => {
      ks.close();
      disableRaw();
      process.stdout.write("\n");
      resolve();
    });
  });
}

/* ------------------------------------------------------------------ *
 *  Boot screen
 * ------------------------------------------------------------------ */
function bootScreen(subtitle) {
  process.stdout.write("\x1b[2J\x1b[H");
  log(paint(LOGO, c.cyan));
  log("");
  log(dim("    " + APP_NAME + " command-line") + "   " + dim("v" + VERSION));
  log("");
  log(dim("    " + subtitle));
  log("");
}

function bootScreenNonInteractive(subtitle) {
  log(paint(LOGO, c.cyan));
  log("");
  log(dim("    " + APP_NAME + " command-line") + "   " + dim("v" + VERSION));
  log("");
  log(dim("    " + subtitle));
  log("");
}

/* ------------------------------------------------------------------ *
 *  Browser open
 * ------------------------------------------------------------------ */
function openBrowser(url) {
  const escaped = JSON.stringify(url);
  const cmds =
    process.platform === "darwin" ? [`open ${escaped}`]
    : process.platform === "win32" ? [`start "" ${escaped}`]
    : [`xdg-open ${escaped}`];
  for (const cmd of cmds) {
    try {
      spawn(cmd, { shell: true, stdio: "ignore", detached: true }).unref();
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 *  Login (browser-based auto-auth)
 * ------------------------------------------------------------------ */
function randomPort() {
  return 42000 + Math.floor(Math.random() * 20000);
}

function login() {
  return new Promise((resolve) => {
    const port = randomPort();
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname === "/complete") {
        const token = url.searchParams.get("token");
        const email = url.searchParams.get("email") || "";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        if (token) {
          res.end(
            "<!doctype html><html><body style='font-family:system-ui;background:#0f0d2e;color:#fff;display:grid;place-items:center;height:100vh;margin:0'>" +
            "<div style='text-align:center'><div style='font-size:48px'>✅</div><h1>NOVA is connected</h1>" +
            "<p style='color:#a1a1aa'>Close this tab and return to your terminal.</p></div></body></html>"
          );
          saveAuth(token, email || "");
          server.close();
          resolve(true);
        } else {
          res.end("<h1 style='font-family:system-ui;background:#0f0d2e;color:#f87171;display:grid;height:100vh;place-items:center;margin:0;text-align:center'>Sign-in failed. Please try again.<br/><small>Close this tab.</small></h1>");
          server.close();
          resolve(false);
        }
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
    server.listen(port, "127.0.0.1", async () => {
      const url = `${readConfig().base || DEFAULT_BASE}/login?cli=1&port=${port}`;
      log(dim("  Waiting for your browser sign-in…"));
      const opened = openBrowser(url);
      if (!opened) {
        log(yellow("  Could not open a browser automatically."));
        log(dim("  Open this URL in your browser, sign in, and the CLI will continue:"));
        log(cyan("  " + url));
      }
    });
    server.on("error", () => resolve(false));
  });
}

/* ------------------------------------------------------------------ *
 *  Auth + status helpers
 * ------------------------------------------------------------------ */
function requireAuth() {
  const cfg = readConfig();
  if (!cfg.token) {
    err("Not logged in. Run `nova login` first.");
    throw new Error("not-authenticated");
  }
  return cfg;
}

function timeAgo(ts) {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60) return `${Math.max(1, sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/* ------------------------------------------------------------------ *
 *  One-shot commands
 * ------------------------------------------------------------------ */
async function cmdMailbox(folderName) {
  const folders = await api("/folders");
  const current = folders.find((f) => (folderName ? f.name.toLowerCase() === folderName.toLowerCase() : f.type === "inbox"));
  if (!current) {
    const names = folders.map((f) => f.name).join(", ");
    err(`Folder not found. Available: ${names}`);
    return;
  }
  const messages = await api(`/messages?folder_id=${encodeURIComponent(current.id)}`);
  if (!messages || messages.length === 0) {
    log(dim("  No messages."));
    return;
  }
  log(bold(`  ${current.name}  `) + dim(`(${messages.length})`) + "\n");
  for (const m of messages) {
    const unread = m.flags === 0 ? bold("● ") : "  ";
    const sender = String(m.sender || "").padEnd(28, " ").slice(0, 28);
    const preview = String(m.preview || "").slice(0, 42);
    log(`  ${unread}${cyan(m.id.slice(0, 8).padEnd(9))} ${sender} ${dim(timeAgo(m.timestamp)).padStart(8)}`.slice(0, 58));
    log(dim(`  ${preview}`));
    log("");
  }
  log(dim("  Run `nova read <id>` to open a message."));
}

async function listMessagesForPicker(folderName) {
  const folders = await api("/folders");
  const current = folders.find((f) => (folderName ? f.name.toLowerCase() === folderName.toLowerCase() : f.type === "inbox"));
  if (!current) return [];
  const data = await api(`/messages?folder_id=${encodeURIComponent(current.id)}`);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.messages)) return data.messages;
  return [];
}

async function cmdRead(id) {
  const detail = await api(`/messages/${id}`);
  log("");
  log(bold(`  ${detail.subject || "(no subject)"}`));
  log("");
  log(dim(`  From:  `) + (detail.sender || ""));
  log(dim(`  To:    `) + (detail.recipients ? (typeof detail.recipients === "string" ? detail.recipients : detail.recipients.join(", ")) : ""));
  log(dim(`  Sent:  `) + new Date((detail.timestamp || 0) * 1000).toLocaleString());
  log("");
  log("  " + "─".repeat(58));
  log("");
  log(detail.body || dim("(no body)"));
  log("");
}

async function sendMessage(to, subject, body) {
  const payload = {
    to: to.split(",").map((s) => s.trim()).filter(Boolean),
    subject: subject || "(no subject)",
    body: body || "",
    is_html: false,
  };
  const res = await api("/send", { method: "POST", body: payload });
  return res;
}

async function cmdSend(to, subject, body) {
  if (!to) {
    err("Missing recipient. Usage: nova send --to you@example.com --subject \"Hi\" --body \"msg\"");
    return;
  }
  const res = await sendMessage(to, subject, body);
  log(green("  Sent.") + (res.id ? dim(` (id ${res.id})`) : ""));
}

async function cmdDelete(id) {
  const detail = await api(`/messages/${id}`);
  const subject = detail.subject || "(no subject)";
  await api(`/messages/${id}`, { method: "POST", body: { action: "trash" } });
  log(green(`  Deleted: `) + subject);
}

async function cmdStatus() {
  const cfg = readConfig();
  const folders = await api("/folders");
  const inbox = folders.find((f) => f.type === "inbox");
  const total = inbox ? (await api(`/messages?folder_id=${inbox.id}`)).length : 0;
  const unread = inbox ? inbox.unread_count : 0;
  log("");
  log(dim("  Account:  ") + (cfg.email || "unknown"));
  log(dim("  Base URL: ") + (cfg.base || DEFAULT_BASE));
  log(dim("  Inbox:    ") + `${total} messages, ${unread} unread`);
  log(dim("  Version:  ") + `CLI ${VERSION}`);
  log(dim("  Repo:     ") + REPO);
  log("");
}

function cmdVersion() {
  log(`${APP_NAME} CLI v${VERSION}`);
}

async function cmdUpdate() {
  try {
    const meta = await (await fetch(`${readConfig().base || DEFAULT_BASE}/api/cli/version`)).json();
    if (!meta.version) throw new Error("bad manifest");
    if (meta.version === VERSION) {
      log(green("  You're on the latest version.") + dim(" (v" + VERSION + ")"));
      return;
    }
    log(yellow(`  A new version is available: v${meta.version} (you have v${VERSION}).`));
    log(dim(`  Grab it from ${REPO} or ${readConfig().base || DEFAULT_BASE}/cli`));
  } catch {
    log(dim("  Could not check for updates."));
  }
}

async function checkForUpdates() {
  try {
    const meta = await (await fetch(`${readConfig().base || DEFAULT_BASE}/api/cli/version`)).json();
    if (meta.version && meta.version !== VERSION) {
      log(dim("  " + `Update available: v${meta.version}. Run \`nova update\`.`));
    }
  } catch {
    /* silent */
  }
}

/* ------------------------------------------------------------------ *
 *  AI bridge (EXPERIMENTAL · NOT RECOMMENDED)
 *  NOVA never runs or trains models. These helpers configure YOUR OWN
 *  model provider API keys and build a master prompt for a BYO agent that
 *  talks to your mailbox through the NOVA AI bridge API.
 * ------------------------------------------------------------------ */
function getAI() {
  const cfg = readConfig();
  return cfg.ai || { provider: "", key: "" };
}

async function aiSettingsFromServer() {
  const cfg = readConfig();
  const base = (cfg.base || DEFAULT_BASE).replace(/\/$/, "");
  const res = await fetch(`${base}/api/ai/settings`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not read AI settings");
  return res.json();
}

function aiMasterPrompt(cfg, aiToken) {
  const base = (cfg.base || DEFAULT_BASE).replace(/\/$/, "");
  return [
    "# NOVA Mail AI agent — master prompt (experimental, NOT RECOMMENDED)",
    "",
    "You are connected to the user's own NOVA Mail inbox via a personal API token.",
    "NOVA itself runs no AI and never reads/trains on mail. You act only on explicit instructions.",
    "Be conservative: drafts are held for approval unless the user enabled auto-approve.",
    "",
    "## Connection",
    `- Base URL: ${base}`,
    `- Auth header on every request: \`x-ai-token: ${aiToken}\``,
    "- Always send `Accept: application/json`.",
    "",
    "## Tools",
    `1. List mail: GET ${base}/api/ai/mailbox?limit=20`,
    `2. Read: GET ${base}/api/ai/mailbox/{id}`,
    `3. Draft for approval: POST ${base}/api/ai/send`,
    '   Body: {"to": ["a@b.com"], "subject": "...", "body": "...", "is_html": false}',
    "",
    "## Rules",
    "- NEVER fabricate a recipient.",
    "- Never claim to have sent something unless the API confirms it.",
    "- Prefer composing a draft (manual approval) unless auto-approve is on.",
    "",
    "# END OF MASTER PROMPT",
  ].join("\n");
}

function aiCurlCommand(cfg, provider, key) {
  const p = AI_PROVIDERS[provider];
  const base = (cfg.base || DEFAULT_BASE).replace(/\/$/, "");
  const authHeader = p.auth.replace("<KEY>", key);
  return [
    "curl -sS " + p.base + "/chat/completions \\",
    `  -H "Content-Type: application/json" \\`,
    `  -H "${authHeader}" \\`,
    '  -d \'{',
    '    "model": "' + p.model + '",',
    '    "max_tokens": 1000,',
    '    "messages": [{',
    '      "role": "user",',
    '      "content": "You are a helpful email assistant bridged to NOVA Mail. " +',
    '        "Endpoint: ' + base + '/api/ai. Auth: x-ai-token header. Read mail, draft replies, submit for approval."',
    '    }]',
    '  }\'',
  ].join("\n");
}

async function aiTest(provider, key) {
  const p = AI_PROVIDERS[provider];
  const body = {
    model: p.model,
    max_tokens: 32,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  };
  const headers = { "Content-Type": "application/json" };
  if (provider === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider === "openai") {
    headers["Authorization"] = `Bearer ${key}`;
  } else if (provider === "nvidia") {
    headers["Authorization"] = `Bearer ${key}`;
  }
  const res = await fetch(`${p.base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = (j.error && (j.error.message || j.error)) || msg; } catch {}
    throw new Error(`${p.label} rejected the key/request: ${msg}`);
  }
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "OK";
}

async function aiGenerateReply(cfg, provider, key, context) {
  const p = AI_PROVIDERS[provider];
  const system = [
    "You draft concise email replies for the user. You are NOT sending anything —",
    "the user will review and approve before anything leaves. Never include fabricated",
    "details. Use a warm, professional tone.",
  ].join(" ");
  const body = {
    model: p.model,
    max_tokens: 500,
    messages: [
      { role: "system", content: system },
      { role: "user", content: context },
    ],
  };
  const headers = { "Content-Type": "application/json" };
  if (provider === "anthropic") headers["x-api-key"] = key;
  else headers["Authorization"] = `Bearer ${key}`;
  const res = await fetch(`${p.base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = (j.error && (j.error.message || j.error)) || msg; } catch {}
    throw new Error(`${p.label} error: ${msg}`);
  }
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
}

/* ------------------------------------------------------------------ *
 *  Interactive shell
 * ------------------------------------------------------------------ */
async function interactiveShell() {
  const cfg = requireAuth();
  bootScreen("Interactive mode · press q to quit a menu");

  for (;;) {
    const menu = [
      "📥  Inbox (list messages)",
      "✉️   Read a message",
      "📤  Compose & send",
      "🤖  AI agent (experimental, NOT recommended)",
      "📊  Status",
      "🚪  Log out",
      "❌  Exit",
    ];
    const choice = await choose(menu, "NOVA — main menu");
    if (choice < 0) continue;
    switch (choice) {
      case 0:
        await intMailbox();
        break;
      case 1:
        await intRead();
        break;
      case 2:
        await intSend();
        break;
      case 3:
        await intAI();
        break;
      case 4:
        await withSpinner("Checking status", cmdStatus);
        await pauseScreen();
        break;
      case 5:
        clearAuth();
        log(green("  Logged out."));
        log(dim(`  Run ${REPO} or \`nova login\` to come back.`));
        return;
      case 6:
        log(green("  Goodbye."));
        return;
    }
  }
}

async function intMailbox() {
  const messages = await withSpinner("Loading inbox", () => listMessagesForPicker());
  if (messages.length === 0) {
    log(dim("  Inbox is empty."));
    await pauseScreen();
    return;
  }
  const labels = messages.map((m) => {
    const t = timeAgo(m.timestamp);
    const s = String(m.sender || "").padEnd(26, " ").slice(0, 26);
    return `${m.flags === 0 ? "● " : "  "}${s} ${t.padStart(8)}  ·  ${String(m.preview || "").slice(0, 28)}`;
  });
  const idx = await choose(labels, "Inbox — pick a message");
  if (idx < 0) return;
  await cmdRead(messages[idx].id);
  await pauseScreen();
}

async function intRead() {
  const id = await readLine("  Message id (or full subject text):  ");
  if (!id.trim()) return;
  try {
    await withSpinner("Fetching message", () => cmdRead(id.trim()));
  } catch (e) {
    err(e.message);
  }
  await pauseScreen();
}

async function intSend() {
  const to = await readLine("  To (comma separated):  ");
  if (!to.trim()) return;
  const subject = await readLine("  Subject:  ");
  log(dim("  Body (leave a blank line to finish):"));
  const body = await readMultiLine();
  if (!body.trim()) {
    const y = await confirm("  Empty body — send anyway?");
    if (!y) return;
  }
  try {
    await withSpinner("Sending", () => sendMessage(to.trim(), subject.trim(), body));
    log(green("  Sent."));
  } catch (e) {
    err(e.message);
  }
  await pauseScreen();
}

async function readMultiLine() {
  const lines = [];
  for (;;) {
    const line = await readLine("");
    if (!line.trim() && lines.length > 0) break;
    lines.push(line);
  }
  return lines.join("\n");
}

async function confirm(prompt) {
  const a = await choose(["Yes", "No"], prompt);
  return a === 0;
}

async function intAI() {
  aiBanner();
  const ai = getAI();
  const cfg = readConfig();

  const items = [
    "Set up / change an AI provider (OpenAI · Anthropic · NVIDIA)",
    "Test your provider key (calls their API)",
    "Get the master prompt for your agent",
    "Get a curl command to connect your provider",
    "Toggle auto-approve for AI drafts",
    "Disable the AI bridge",
    "Back",
  ];
  const choice = await choose(items, "AI agent — experimental");
  if (choice <= 0) {
    // Set up provider
    const provNames = Object.keys(AI_PROVIDERS).map((k) => `${AI_PROVIDERS[k].label}`);
    const pIdx = await choose(provNames, "Choose a provider");
    if (pIdx < 0) return;
    const provider = Object.keys(AI_PROVIDERS)[pIdx];
    const key = await readLine(`  ${AI_PROVIDERS[provider].label} API key (hidden):  `, { echo: (s) => "•".repeat(s.length) });
    if (!key.trim()) { log(dim("  Aborted.")); return; }
    ai.provider = provider;
    ai.key = key.trim();
    cfg.ai = ai;
    writeConfig(cfg);
    log(green("  Saved. ") + dim("Your key stays in local config (~/.nova/config.json)."));
    await pauseScreen();
    return;
  }
  if (choice === 1) {
    if (!ai.provider || !ai.key) { err("No provider configured yet — choose 'Set up' first."); return; }
    try {
      await withSpinner(`Testing ${AI_PROVIDERS[ai.provider].label} key`, () => aiTest(ai.provider, ai.key));
      log(green("  Key works."));
    } catch (e) {
      err(e.message);
    }
    await pauseScreen();
    return;
  }
  if (choice === 2) {
    let aiToken = "";
    try {
      const s = await aiSettingsFromServer();
      aiToken = s.token_prefix ? `...${s.token_prefix.slice(2)}` : "";
    } catch {}
    log("\n" + aiMasterPrompt(cfg, aiToken || "<your-ai-token>"));
    await pauseScreen();
    return;
  }
  if (choice === 3) {
    if (!ai.provider || !ai.key) { err("No provider configured yet."); return; }
    log("\n" + aiCurlCommand(cfg, ai.provider, "[YOUR_SERVER_TOKEN]") + "\n");
    await pauseScreen();
    return;
  }
  if (choice === 4) {
    try {
      const s = await aiSettingsFromServer();
      const now = s.auto_approve === 1 ? 0 : 1;
      await fetch(`${(cfg.base || DEFAULT_BASE).replace(/\/$/, "")}/api/ai/auto-approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ auto_approve: now }),
      });
      log(now === 1 ? yellow("  Auto-approve ON. AI drafts send immediately — use with care.") : green("  Auto-approve OFF (manual review)."));
    } catch (e) {
      err(e.message);
    }
    await pauseScreen();
    return;
  }
  if (choice === 5) {
    try {
      await fetch(`${(cfg.base || DEFAULT_BASE).replace(/\/$/, "")}/api/ai/disable`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
      log(green("  AI bridge disabled. Token revoked."));
    } catch (e) {
      err(e.message);
    }
    await pauseScreen();
    return;
  }
  // choice 6 = back
  return;
}

/* ------------------------------------------------------------------ *
 *  Parse args + dispatch
 * ------------------------------------------------------------------ */
function parseFlag(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1];
      if (args[i] && args[i].startsWith(n + "=")) return args[i].slice(n.length + 1);
    }
  }
  return undefined;
}

const HELP = `
${KEY} ${bold(APP_NAME + " CLI")}  v${VERSION}   ·   Open source: ${REPO}

${bold("Usage:")}
  nova                       Open the interactive menu
  nova <command> [options]   Run a one-shot command

${bold("Commands:")}
  login                     Sign in with your browser
  logout                    Remove the saved session
  mailbox [folder]          List messages (default: Inbox)
  read <message-id>         Show a message
  send --to A --subject S --body B    Send a message
  delete <message-id>       Move a message to trash
  status                    Show account + connection status
  ai                        AI agent helpers (EXPERIMENTAL · NOT RECOMMENDED)
  version                   Show CLI version
  update                    Check for the latest version
  help                      Show this help

${bold("Global options:")}
  --base <url>              Custom NOVA base URL (default ${DEFAULT_BASE})
  --no-color                Disable colors

${bold("AI (experimental, not recommended):")}
  nova ai setup             Choose OpenAI / Anthropic / NVIDIA + enter API key
  nova ai test              Verify your provider key
  nova ai prompt            Print the master prompt for your BYO agent
  nova ai curl [provider]   Print a ready-to-run curl connect command
`;

async function main() {
  const argv = process.argv.slice(2);
  const raw = argv[0];

  const baseOverride = parseFlag(argv, ["--base", "--api"]);
  if (baseOverride) {
    const cfg = readConfig();
    cfg.base = baseOverride;
    writeConfig(cfg);
  }
  if (argv.includes("--no-color")) process.env.NO_COLOR = "1";

  // Interactive entry: `nova` with no args (or `nova run` / `nova menu`).
  if (!raw || raw === "run" || raw === "menu" || raw === "interactive") {
    try {
      requireAuth();
    } catch {
      bootScreenNonInteractive("Interactive mode");
      const ok = await login();
      if (!ok) return;
    }
    await interactiveShell();
    return;
  }

  const cmd = raw;

  if (cmd === "help" || cmd === "-h" || cmd === "--help") { log(HELP.trim()); return; }
  if (cmd === "version" || cmd === "-v" || cmd === "--version") { cmdVersion(); return; }

  const authCommands = new Set(["mailbox", "read", "send", "delete", "status"]);
  const known = new Set([...authCommands, "login", "logout", "update", "ai"]);
  if (!known.has(cmd)) {
    err(`Unknown command: ${cmd}. Run \`nova --help\`.`);
    return;
  }

  if (authCommands.has(cmd)) {
    try { requireAuth(); } catch { return; }
  }

  bootScreenNonInteractive("Connected · type `nova` for the interactive menu");

  try {
    switch (cmd) {
      case "login": {
        const ok = await login();
        if (ok) {
          const cfg = readConfig();
          log(green("  Authenticated as ") + bold(cfg.email || "your account"));
          log("");
          log(dim("  Run `nova` for the interactive menu."));
        } else {
          err("Sign-in incomplete.");
        }
        break;
      }
      case "logout": { clearAuth(); log(green("  Logged out.")); break; }
      case "mailbox": await withSpinner("Loading mailbox", () => cmdMailbox(argv[1])); break;
      case "read": {
        if (!argv[1]) return err("Usage: nova read <message-id>");
        await withSpinner("Fetching message", () => cmdRead(argv[1]));
        break;
      }
      case "send": {
        const to = parseFlag(argv, ["--to", "-t"]);
        const subject = parseFlag(argv, ["--subject", "-s"]);
        const body = parseFlag(argv, ["--body", "-b"]) || parseFlag(argv, ["--message", "-m"]);
        await withSpinner("Sending", () => cmdSend(to, subject, body));
        break;
      }
      case "delete": {
        if (!argv[1]) return err("Usage: nova delete <message-id>");
        await withSpinner("Deleting", () => cmdDelete(argv[1]));
        break;
      }
      case "status": await withSpinner("Checking status", cmdStatus); break;
      case "update": await cmdUpdate(); break;
      case "ai": {
        const sub = argv[1] || "menu";
        if (sub === "setup") {
          aiBanner();
          const cfg = readConfig();
          const provNames = Object.keys(AI_PROVIDERS).map((k) => `${AI_PROVIDERS[k].label}`);
          const pIdx = await choose(provNames, "Choose a provider (experimental)");
          if (pIdx < 0) break;
          const provider = Object.keys(AI_PROVIDERS)[pIdx];
          const key = await readLine(`  ${AI_PROVIDERS[provider].label} API key:  `);
          if (!key.trim()) { log(dim("  Aborted.")); break; }
          cfg.ai = { provider, key: key.trim() };
          writeConfig(cfg);
          log(green("  Saved."));
        } else if (sub === "test") {
          aiBanner();
          const ai = getAI();
          if (!ai.provider || !ai.key) return err("No provider configured. Run `nova ai setup` first.");
          try {
            const out = await withSpinner(`Testing ${AI_PROVIDERS[ai.provider].label} key`, () => aiTest(ai.provider, ai.key));
            log(green("  Key works.") + (out ? dim(` (model said: ${out})`) : ""));
          } catch (e) { err(e.message); }
        } else if (sub === "prompt") {
          aiBanner();
          const cfg = readConfig();
          log("\n" + aiMasterPrompt(cfg, "<your-ai-token>") + "\n");
        } else if (sub === "curl") {
          aiBanner();
          const cfg = readConfig();
          const ai = getAI();
          const provider = argv[2] || ai.provider || "openai";
          if (!AI_PROVIDERS[provider]) return err(`Unknown provider '${provider}'.`);
          log("\n" + aiCurlCommand(cfg, provider, "[YOUR_SERVER_TOKEN]") + "\n");
        } else {
          log(HELP.trim());
        }
        break;
      }
      default:
        return err(`Unknown command: ${cmd}. Run \`nova --help\`.`);
    }
  } catch (e) {
    if (e.message === "not-authenticated") return;
    err(String(e && e.message ? e.message : e));
  }

  if (cmd !== "login" && !["ai"].includes(cmd)) checkForUpdates();
}

main();
