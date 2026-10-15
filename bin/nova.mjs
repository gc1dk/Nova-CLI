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
 * The token is only ever sent to 127.0.0.1 (your own machine), and the
 * handshake is bound to a random `state` value so a stray page or local
 * process cannot inject a token.
 *
 * Secrets (session token, BYO-provider API keys) are encrypted at rest with
 * AES-256-GCM under a random per-machine key (~/.nova/key, mode 0600). Only
 * non-sensitive values (base URL, account e-mail, provider name) are stored in
 * the clear. See the Security section in the README for the threat model.
 *
 * Run `nova` with no arguments for the interactive menu, or use the one-shot
 * commands below for scripting.
 */

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Windows consoles default to a legacy code page (e.g. 437/1252) that turns our
// UTF-8 box-drawing and punctuation into mojibake. Bump the active console to
// UTF-8 when we own an interactive terminal. Harmless elsewhere.
if (process.platform === "win32" && process.stdout.isTTY) {
  try { spawnSync("chcp", ["65001"], { stdio: "ignore", shell: true }); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 *  Constants
 * ------------------------------------------------------------------ */
const APP_NAME = "NOVA Mail";
const DEFAULT_BASE = "https://nova-email.com";
const VERSION = "0.4.2";
const REPO = "https://github.com/gc1dk/Nova-CLI";
const CONFIG_DIR = path.join(os.homedir(), ".nova");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const KEY_FILE = path.join(CONFIG_DIR, "key");
const UA = `nova-cli/${VERSION}`;

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
  blue: "\x1b[34m",
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
const blue = (s) => paint(s, c.blue);
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
  log(red(bold("✖ ")) + red(String(msg)));
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
 *  Text safety + width (fixes mojibake, broken columns, and terminal
 *  escape-sequence injection from untrusted mail content)
 * ------------------------------------------------------------------ */

// Strip ANSI/escape sequences and control characters from anything we print
// that came from the server (subjects, bodies, senders, previews…). A hostile
// message must not be able to move the cursor, recolor the UI, or clear the
// screen. Keeps newline + tab.
function sanitize(input) {
  let s = String(input ?? "");
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ""); // OSC ... BEL/ST
  s = s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");           // CSI sequences
  s = s.replace(/\x1b[()][0-9A-Za-z]/g, "");                // charset select
  s = s.replace(/\x1b[@-_]/g, "");                          // other 2-char seqs
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");   // leftover controls
  return s;
}

// East-Asian wide + common emoji ranges count as two columns so tables line up.
function charWidth(cp) {
  if (cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  )) return 2;
  return 1;
}
function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += charWidth(ch.codePointAt(0));
  return w;
}
// Code-point aware truncation (never splits a surrogate pair), by display width.
function truncate(s, maxWidth) {
  let out = "";
  let w = 0;
  for (const ch of String(s)) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > maxWidth) return out + (maxWidth - w >= 1 ? "…" : "");
    out += ch;
    w += cw;
  }
  return out;
}
function padEndW(s, width) {
  const d = width - strWidth(s);
  return d > 0 ? s + " ".repeat(d) : s;
}
function padStartW(s, width) {
  const d = width - strWidth(s);
  return d > 0 ? " ".repeat(d) + s : s;
}

/* ------------------------------------------------------------------ *
 *  Config — encrypted vault for secrets
 * ------------------------------------------------------------------ */

function ensureDir() {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
}

// Write atomically with owner-only permissions where the OS supports it.
function writePrivate(file, data) {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows: best-effort */ }
}

// The per-machine wrapping key. 32 random bytes, base64, stored 0600 next to
// the config. Losing it means secrets are unreadable (re-login to recover).
function loadOrCreateKey() {
  try {
    const raw = fs.readFileSync(KEY_FILE, "utf8").trim();
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) return buf;
  } catch { /* create below */ }
  const buf = randomBytes(32);
  writePrivate(KEY_FILE, buf.toString("base64") + "\n");
  return buf;
}

function seal(obj) {
  const key = loadOrCreateKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "v1:" + iv.toString("base64") + "." + Buffer.concat([ct, tag]).toString("base64");
}

function unseal(str) {
  if (typeof str !== "string" || !str.startsWith("v1:")) return null;
  const parts = str.slice(3).split(".");
  if (parts.length !== 2) return null;
  const key = loadOrCreateKey();
  const iv = Buffer.from(parts[0], "base64");
  const data = Buffer.from(parts[1], "base64");
  if (data.length < 16) return null;
  const tag = data.subarray(data.length - 16);
  const ct = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

function readRaw() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}
function writeRaw(cfg) {
  writePrivate(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

// Public (non-secret) config view.
function readConfig() {
  const cfg = readRaw();
  return { base: cfg.base, email: cfg.email, ai: cfg.ai ? { provider: cfg.ai.provider } : undefined };
}

// Decrypt secrets, transparently migrating a legacy plaintext config.
function readSecrets() {
  const cfg = readRaw();
  if (typeof cfg.secrets === "string") {
    try { return unseal(cfg.secrets) || {}; } catch { return {}; }
  }
  const legacy = {};
  if (cfg.token) legacy.token = cfg.token;
  if (cfg.ai && cfg.ai.key) legacy.aiKey = cfg.ai.key;
  if (Object.keys(legacy).length) {
    const clean = { ...cfg };
    delete clean.token;
    if (clean.ai) clean.ai = { provider: clean.ai.provider || "" };
    clean.v = 2;
    clean.secrets = seal(legacy);
    writeRaw(clean);
    return legacy;
  }
  return {};
}

function currentBase() {
  return normalizeBase(readConfig().base || DEFAULT_BASE);
}
function getToken() {
  return readSecrets().token || "";
}
function getAiKey() {
  return readSecrets().aiKey || "";
}
function setBase(base) {
  const cfg = readRaw();
  cfg.base = normalizeBase(base);
  writeRaw(cfg);
}
function saveAuth(token, email) {
  const cfg = readRaw();
  const s = readSecrets();
  if (token) s.token = token;
  cfg.email = email || cfg.email || "";
  if (!cfg.base) cfg.base = DEFAULT_BASE;
  cfg.v = 2;
  cfg.secrets = seal(s);
  writeRaw(cfg);
}
function saveAi(provider, key) {
  const cfg = readRaw();
  const s = readSecrets();
  cfg.ai = { provider };
  if (key) s.aiKey = key;
  cfg.v = 2;
  cfg.secrets = seal(s);
  writeRaw(cfg);
}
function clearAuth() {
  const cfg = readRaw();
  const s = readSecrets();
  delete s.token;
  cfg.email = "";
  cfg.v = 2;
  cfg.secrets = seal(s);
  writeRaw(cfg);
}

/* ------------------------------------------------------------------ *
 *  Base URL validation (never send credentials over plaintext http)
 * ------------------------------------------------------------------ */
function isLoopback(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
function normalizeBase(input) {
  const raw = String(input || DEFAULT_BASE).trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error(`Invalid base URL: ${raw}`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Base URL must start with https:// (or http://localhost).");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new Error("Refusing to send credentials over plain http. Use https:// or a localhost address.");
  }
  const sub = url.pathname.replace(/\/+$/, "");
  return url.origin + sub;
}

/* ------------------------------------------------------------------ *
 *  Network helpers
 * ------------------------------------------------------------------ */

// fetch() with a hard timeout so a dead/slow network never hangs the CLI.
async function fetchT(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e && (e.name === "AbortError" || e.code === "ABORT_ERR")) throw new Error(`Request timed out after ${ms / 1000}s.`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function api(pathname, { method = "GET", body, token, raw = false } = {}) {
  const base = currentBase();
  const tok = token || getToken();
  const headers = { Accept: "application/json", "User-Agent": UA };
  if (tok) headers.Authorization = `Bearer ${tok}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetchT(`${base}/api/mailbox${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Could not reach ${base} (${e && e.cause ? e.cause.code || e.cause.message : e.message}).`);
  }
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { data = null; }
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

// Chunk-safe raw-mode input. Terminals may split an escape sequence across
// multiple data chunks (and may send SS3/CSI sequences), so we buffer input
// and parse whole key tokens from the stream rather than reading a single chunk.
const SS3_MAP = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const CSI_MAP = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const CSI_TILDE_MAP = { 1: "home", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end" };

function parseKey(buf) {
  if (!buf) return null;
  const ch = buf[0];
  if (ch === "\u0003") return { key: "ctrl-c", len: 1 };
  if (ch === "\r" || ch === "\n") return { key: "enter", len: 1 };
  if (ch === "\u007f" || ch === "\b") return { key: "backspace", len: 1 };
  if (ch >= " ") {
    const cp = buf.codePointAt(0);
    const k = String.fromCodePoint(cp);
    return { key: k, len: k.length };
  }
  if (ch !== "\u001b") return { key: null, len: 1 };
  if (buf.length === 1) return null;
  if (buf[1] === "O") {
    if (buf.length < 3) return null;
    return { key: SS3_MAP[buf[2]] || null, len: 3 };
  }
  if (buf[1] === "[") {
    let j = 2;
    while (j < buf.length && ((buf[j] >= "0" && buf[j] <= "9") || buf[j] === ";" || buf[j] === ":")) j++;
    if (j >= buf.length) return null;
    const fin = buf[j];
    const n = Number.parseInt(buf.slice(2, j), 10);
    let key = CSI_MAP[fin];
    if (!key && fin === "~") key = CSI_TILDE_MAP[Number.isNaN(n) ? 0 : n];
    return { key: key || null, len: j + 1 };
  }
  return { key: null, len: 2 };
}

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
    if (buf === "\u001b") {
      timer = setTimeout(() => {
        timer = null;
        buf = "";
        deliver("\u001b");
      }, 60);
    }
  };
  const onData = (d) => { buf += d; flush(); };
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

function readLine(prompt, opts = {}) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      process.stdout.write(prompt);
      let data = "";
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      const onData = (d) => {
        data += d;
        const nl = data.search(/[\r\n]/);
        if (nl !== -1) {
          process.stdin.off("data", onData);
          process.stdin.pause();
          resolve(data.slice(0, nl));
        }
      };
      process.stdin.on("data", onData);
      return;
    }
    enableRaw();
    let buf = "";
    let cur = 0;
    const shown = () => (opts.echo ? opts.echo(buf) : buf);
    const render = () => {
      const s = shown();
      process.stdout.write("\r" + prompt + s + (s.length ? " " : "") + "\x1b[K");
      const before = opts.echo ? opts.echo(buf.slice(0, cur)) : buf.slice(0, cur);
      const back = Math.max(0, strWidth(s) - strWidth(before));
      if (back > 0) process.stdout.write(`\x1b[${back}D`);
    };
    render();
    const ks = keyStream();
    (async () => {
      for (;;) {
        const k = await ks.next();
        if (k === "ctrl-c") { ks.close(); disableRaw(); process.stdout.write("\n"); process.exit(1); }
        if (k === "enter") { ks.close(); disableRaw(); process.stdout.write("\n"); resolve(buf); return; }
        if (k === "backspace") { if (cur > 0) { buf = buf.slice(0, cur - 1) + buf.slice(cur); cur--; render(); } continue; }
        if (k === "delete") { if (cur < buf.length) { buf = buf.slice(0, cur) + buf.slice(cur + 1); render(); } continue; }
        if (k === "left") { if (cur > 0) { cur--; render(); } continue; }
        if (k === "right") { if (cur < buf.length) { cur++; render(); } continue; }
        if (k === "home") { cur = 0; render(); continue; }
        if (k === "end") { cur = buf.length; render(); continue; }
        if (typeof k === "string" && [...k].length === 1 && k >= " ") {
          buf = buf.slice(0, cur) + k + buf.slice(cur);
          cur += k.length;
          render();
          continue;
        }
      }
    })();
  });
}

// Clear the visible screen AND the scrollback so repeated redraws never leave
// stale frames behind (the "a new menu keeps appearing when I scroll" bug).
function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

// Arrow-key list selector. Returns index, or -1 if cancelled (q/Esc).
function choose(items, prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(0); return; }
    let idx = 0;
    // Reserve room for the boot logo (~12 lines) + the nav hint, so a full
    // frame never overflows the terminal (an overflow scrolls and duplicates).
    const pageSize = Math.max(4, (process.stdout.rows || 24) - 15);
    const top = () => Math.max(0, Math.min(idx - 2, Math.max(0, items.length - pageSize)));
    const draw = () => {
      clearScreen();
      bootScreen(prompt || "Select an option");
      const lo = top();
      const list = items.slice(lo, lo + pageSize);
      list.forEach((item, i) => {
        const label = sanitize(item);
        if (lo + i === idx) log("  " + paint("› ", c.cyan) + "  " + paint(label, c.bold));
        else log("    " + label);
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
      clearScreen();
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

function confirm(prompt) {
  return choose(["Yes", "No"], prompt).then((a) => a === 0);
}

/* ------------------------------------------------------------------ *
 *  Boot screen
 * ------------------------------------------------------------------ */
function bootScreen(subtitle) {
  clearScreen();
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
  let cmd;
  if (process.platform === "darwin") cmd = `open ${escaped}`;
  else if (process.platform === "win32") cmd = `start "" ${escaped}`;
  else cmd = `xdg-open ${escaped}`;
  try {
    spawn(cmd, { shell: true, stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 *  Login (browser-based auto-auth, CSRF-state protected)
 * ------------------------------------------------------------------ */
function randomPort() {
  return 42000 + Math.floor(Math.random() * 20000);
}

function login() {
  return new Promise((resolve) => {
    const port = randomPort();
    const state = randomBytes(16).toString("hex"); // binds the callback to us
    let settled = false;
    let timer = null;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { server.close(); } catch { /* ignore */ }
      resolve(val);
    };
    const page = (title, color, note) =>
      "<!doctype html><html><body style='font-family:system-ui;background:#0f0d2e;color:#fff;display:grid;place-items:center;height:100vh;margin:0'>" +
      `<div style='text-align:center'><div style='font-size:48px'>${title}</div>` +
      `<h1 style='color:${color}'>${note}</h1>` +
      "<p style='color:#a1a1aa'>You can close this tab and return to your terminal.</p></div></body></html>";

    const server = http.createServer((req, res) => {
      if (req.method !== "GET") { res.writeHead(405); res.end("Method not allowed"); return; }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== "/complete") { res.writeHead(404); res.end("Not found"); return; }
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      const token = url.searchParams.get("token");
      const email = url.searchParams.get("email") || "";
      const gotState = url.searchParams.get("state") || "";
      if (token && gotState === state) {
        res.writeHead(200);
        res.end(page("✅", "#34d399", "NOVA is connected"));
        saveAuth(token, email);
        finish(true);
      } else {
        res.writeHead(200);
        res.end(page("⚠️", "#f87171", "Sign-in failed — please try again"));
        finish(false);
      }
    });
    server.on("error", () => finish(false));
    timer = setTimeout(() => {
      log(yellow("  Timed out waiting for the browser. ")) ;
      finish(false);
    }, 5 * 60 * 1000);

    server.listen(port, "127.0.0.1", () => {
      let base;
      try { base = currentBase(); } catch (e) { err(e.message); finish(false); return; }
      const url = `${base}/login?cli=1&port=${port}&state=${state}`;
      log(dim("  Waiting for your browser sign-in…"));
      const ok = openBrowser(url);
      if (!ok) {
        log(yellow("  Could not open a browser automatically."));
        log(dim("  Open this URL in your browser, sign in, and the CLI will continue:"));
        log(cyan("  " + url));
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 *  Auth + misc helpers
 * ------------------------------------------------------------------ */
function requireAuth() {
  if (!getToken()) {
    err("Not logged in. Run `nova login` first.");
    throw new Error("not-authenticated");
  }
}

function timeAgo(ts) {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 0) return "just now";
  if (sec < 60) return `${Math.max(1, sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === "#") {
      const cp = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
    return Object.prototype.hasOwnProperty.call(named, ent) ? named[ent] : m;
  });
}

// Best-effort HTML → readable plain text for terminal display.
function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote|pre)>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "  • ");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function emitJSON(obj) {
  log(JSON.stringify(obj, null, 2));
}

// "Name <addr>" → prefer the display name; drop a redundant duplicate address.
function fmtAddr(input) {
  const v = String(input || "").trim();
  const m = v.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    const name = m[1].replace(/^"|"$/g, "").trim();
    const addr = m[2].trim();
    return name && name.toLowerCase() !== addr.toLowerCase() ? `${name} <${addr}>` : addr;
  }
  return v;
}
function displaySender(m) {
  return sanitize(m.sender_name ? m.sender_name : fmtAddr(m.sender || ""));
}
function fmtRecipients(r) {
  if (!r) return "";
  if (Array.isArray(r)) return r.map((x) => (typeof x === "string" ? x : (x && x.address) || "")).filter(Boolean).join(", ");
  const s = String(r);
  if (s.trim().startsWith("[")) {
    try {
      const a = JSON.parse(s);
      if (Array.isArray(a)) return a.map((x) => (typeof x === "string" ? x : (x && x.address) || "")).filter(Boolean).join(", ");
    } catch { /* not JSON */ }
  }
  return s;
}

/* ------------------------------------------------------------------ *
 *  Folder + message helpers
 * ------------------------------------------------------------------ */

// GET /folders → array of {id,name,type,unread_count}
async function getFolders() {
  const data = await api("/folders");
  return Array.isArray(data) ? data : (data && data.folders) || [];
}

function findFolder(folders, name) {
  if (!name) return folders.find((f) => f.type === "inbox") || folders[0];
  const n = name.toLowerCase();
  return folders.find((f) => f.type === n) ||
         folders.find((f) => f.name.toLowerCase() === n) ||
         folders.find((f) => f.id === name);
}

// One page of messages. Returns { messages, has_more, next_cursor }.
async function listPage(folder, { limit = 50, query = "" } = {}) {
  const qs = new URLSearchParams();
  qs.set("folder", folder);
  qs.set("limit", String(Math.min(100, Math.max(1, limit))));
  if (query) qs.set("q", query);
  const data = await api("/messages?" + qs.toString());
  if (Array.isArray(data)) return { messages: data, has_more: false, next_cursor: null };
  return {
    messages: (data && data.messages) || [],
    has_more: !!(data && data.has_more),
    next_cursor: (data && data.next_cursor) || null,
  };
}

// Follow the cursor to the end (bounded so a huge inbox cannot run away).
async function listAll(folder, { query = "", cap = 1000 } = {}) {
  const out = [];
  let cursor = null;
  for (;;) {
    const qs = new URLSearchParams();
    qs.set("folder", folder);
    qs.set("limit", "100");
    if (query) qs.set("q", query);
    if (cursor) { qs.set("before", cursor.before); qs.set("before_id", cursor.before_id || ""); }
    const data = await api("/messages?" + qs.toString());
    const page = Array.isArray(data) ? data : (data && data.messages) || [];
    out.push(...page);
    const hasMore = !Array.isArray(data) && data && data.has_more && data.next_cursor;
    if (!hasMore || page.length === 0 || out.length >= cap) break;
    cursor = data.next_cursor;
  }
  return out;
}

// Accept a full uuid or the short id shown in listings.
async function resolveId(input) {
  const v = String(input || "").trim();
  if (!v) throw new Error("Missing message id.");
  if (v.length >= 32) return v;
  const folders = await getFolders();
  for (const f of folders) {
    if (f.type === "starred" || f.type === "snoozed") continue;
    try {
      const { messages } = await listPage(f.id, { limit: 100 });
      const hit = messages.find((m) => String(m.id).startsWith(v));
      if (hit) return hit.id;
    } catch { /* keep looking */ }
  }
  return v; // let the server answer (404)
}

/* ------------------------------------------------------------------ *
 *  One-shot commands
 * ------------------------------------------------------------------ */
async function cmdMailbox(folderName, { all = false, limit = 25, json = false } = {}) {
  const folders = await getFolders();
  const current = findFolder(folders, folderName);
  if (!current) {
    err(`Folder not found. Available: ${folders.map((f) => f.name).join(", ")}`);
    return;
  }
  let messages, hasMore;
  if (all) {
    messages = await listAll(current.id);
    hasMore = false;
  } else {
    const page = await listPage(current.id, { limit });
    messages = page.messages;
    hasMore = page.has_more;
  }
  if (json) { emitJSON({ folder: current.name, messages }); return; }
  if (messages.length === 0) { log(dim("  No messages.")); return; }

  log(bold(`  ${sanitize(current.name)}  `) + dim(`(${messages.length}${hasMore ? "+" : ""})`) + "\n");
  for (const m of messages) {
    const unread = (m.flags & 1) === 0 ? bold("●") : " ";
    const star = (m.flags & 2) === 2 ? yellow("★") : " ";
    const id = padEndW(String(m.id).slice(0, 8), 8);
    const sender = padEndW(truncate(displaySender(m) || "(unknown)", 24), 24);
    const when = padStartW(timeAgo(m.timestamp), 9);
    log(`  ${unread}${star} ${cyan(id)}  ${sender}  ${dim(when)}`);
    log(dim("        " + truncate(sanitize(m.subject || "(no subject)"), 64)));
  }
  log("");
  if (hasMore) log(dim(`  ${limit} shown — more available. Use --all for the rest, or --limit N.`));
  log(dim("  Run `nova read <id>` to open a message."));
}

async function cmdFolders({ json = false } = {}) {
  const folders = await getFolders();
  if (json) { emitJSON(folders); return; }
  log("");
  for (const f of folders) {
    const unread = f.unread_count ? yellow(` (${f.unread_count})`) : "";
    log(`  ${padEndW(truncate(sanitize(f.name), 20), 20)} ${dim(f.type)}${unread}`);
  }
  log("");
}

async function cmdRead(id, { json = false, markRead = true } = {}) {
  const real = await resolveId(id);
  const d = await api(`/messages/${encodeURIComponent(real)}`);
  if (json) { emitJSON(d); return; }
  const subject = sanitize(d.subject || "(no subject)");
  const to = fmtRecipients(d.recipients);
  log("");
  log(bold("  " + subject));
  log("");
  log(dim("  From:  ") + sanitize(d.sender || ""));
  log(dim("  To:    ") + sanitize(to));
  log(dim("  Sent:  ") + new Date((d.timestamp || 0) * 1000).toLocaleString());
  if (d.is_encrypted) log(dim("  ") + green("🔒 encrypted at rest"));
  log("");
  log("  " + "─".repeat(60));
  log("");
  const raw = d.body || "";
  const text = d.is_html ? htmlToText(raw) : String(raw);
  log(text ? sanitize(text) : dim("(no body)"));
  log("");
  if (markRead && (d.flags & 1) === 0) {
    try { await api(`/messages/${encodeURIComponent(real)}/read`, { method: "POST" }); } catch { /* non-fatal */ }
  }
}

async function sendMessage(to, subject, body, { cc, bcc, html = false } = {}) {
  const payload = {
    to: String(to).split(",").map((s) => s.trim()).filter(Boolean),
    subject: subject || "(no subject)",
    body: body || "",
    is_html: !!html,
  };
  if (cc) payload.cc = String(cc).split(",").map((s) => s.trim()).filter(Boolean);
  if (bcc) payload.bcc = String(bcc).split(",").map((s) => s.trim()).filter(Boolean);
  return api("/send", { method: "POST", body: payload });
}

async function cmdSend(to, subject, body, opts = {}) {
  if (!to) {
    err('Missing recipient. Usage: nova send --to you@example.com --subject "Hi" --body "msg"');
    return;
  }
  const res = await sendMessage(to, subject, body, opts);
  log(green("  Sent.") + (res && res.id ? dim(` (id ${res.id})`) : ""));
  if (res && res.failed && res.failed.length) log(yellow("  Not delivered: ") + sanitize(res.failed.join(", ")));
}

async function cmdDelete(id, { permanent = false } = {}) {
  const real = await resolveId(id);
  const d = await api(`/messages/${encodeURIComponent(real)}`);
  const subject = sanitize(d.subject || "(no subject)");
  if (permanent) {
    await api(`/messages/${encodeURIComponent(real)}/permanent`, { method: "POST" });
    log(green("  Permanently deleted: ") + subject);
  } else {
    await api(`/messages/${encodeURIComponent(real)}`, { method: "POST", body: { action: "trash" } });
    log(green("  Moved to trash: ") + subject);
  }
}

async function cmdMark(id, action) {
  const real = await resolveId(id);
  if (!["read", "unread", "star", "unstar"].includes(action)) {
    err("Usage: nova mark <id> read|unread|star|unstar");
    return;
  }
  // `/star` on the server is a toggle, so make star/unstar deterministic by
  // checking the current flag first and only toggling when the state differs.
  if (action === "star" || action === "unstar") {
    const d = await api(`/messages/${encodeURIComponent(real)}`);
    const isStarred = (Number(d.flags || 0) & 2) === 2;
    const want = action === "star";
    if (isStarred === want) {
      log(dim(`  Already ${want ? "starred" : "unstarred"}: `) + real);
      return;
    }
    await api(`/messages/${encodeURIComponent(real)}/star`, { method: "POST" });
    log(green(`  ${action}: `) + real);
    return;
  }
  await api(`/messages/${encodeURIComponent(real)}/${action}`, { method: "POST" });
  log(green(`  ${action}: `) + real);
}

async function cmdMove(id, folderName) {
  if (!folderName) { err("Usage: nova move <id> <folder>"); return; }
  const real = await resolveId(id);
  const folders = await getFolders();
  const target = findFolder(folders, folderName);
  if (!target) { err(`Folder not found: ${folderName}`); return; }
  await api(`/messages/${encodeURIComponent(real)}/move`, { method: "POST", body: { target_folder_id: target.id } });
  log(green(`  Moved to ${sanitize(target.name)}.`));
}

async function cmdSearch(query, { json = false, limit = 25, folder = "" } = {}) {
  if (!query) { err("Usage: nova search <query>"); return; }
  let results;
  if (folder) {
    const f = findFolder(await getFolders(), folder);
    if (!f) { err(`Folder not found: ${folder}`); return; }
    results = (await listPage(f.id, { limit, query })).messages;
  } else {
    // The API searches within one folder at a time, so fan out across every
    // real folder and merge by recency. Starred/snoozed are views, not folders.
    const folders = (await getFolders()).filter((f) => f.type !== "starred" && f.type !== "snoozed");
    const pages = await Promise.all(
      folders.map((f) => listPage(f.id, { limit, query }).catch(() => ({ messages: [] })))
    );
    const seen = new Set();
    results = [];
    for (const p of pages) {
      for (const m of p.messages) {
        if (!seen.has(m.id)) { seen.add(m.id); results.push(m); }
      }
    }
    results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    results = results.slice(0, Math.max(1, limit));
  }
  if (json) { emitJSON(results); return; }
  if (!results.length) { log(dim("  No matches.")); return; }
  const scope = folder ? ` in ${sanitize(folder)}` : "";
  log(bold(`  Matches for "${sanitize(query)}"`) + dim(`${scope} (${results.length})`) + "\n");
  for (const m of results) {
    const sender = padEndW(truncate(displaySender(m), 24), 24);
    log(`  ${cyan(padEndW(String(m.id).slice(0, 8), 8))}  ${sender}  ${dim(padStartW(timeAgo(m.timestamp), 9))}`);
    log(dim("        " + truncate(sanitize(m.subject || "(no subject)"), 64)));
  }
  log("");
}

async function cmdStatus({ json = false } = {}) {
  const base = readConfig().base || DEFAULT_BASE;
  const folders = await getFolders();
  const inbox = folders.find((f) => f.type === "inbox");
  let total = 0;
  let hasMore = false;
  if (inbox) {
    const page = await listPage(inbox.id, { limit: 100 });
    total = page.messages.length;
    hasMore = page.has_more;
  }
  let who = readConfig().email || "";
  if (!who) { try { who = (await api("/user")).email || ""; } catch { /* ignore */ } }
  if (json) {
    emitJSON({ account: who, base, inbox: { shown: total, has_more: hasMore, unread: inbox ? inbox.unread_count : 0 }, version: VERSION });
    return;
  }
  log("");
  log(dim("  Account:  ") + (who || "unknown"));
  log(dim("  Base URL: ") + base);
  log(dim("  Inbox:    ") + `${total}${hasMore ? "+" : ""} message${total === 1 && !hasMore ? "" : "s"}, ${inbox ? inbox.unread_count : 0} unread`);
  log(dim("  Secrets:  ") + green("encrypted at rest") + dim(` (${CONFIG_FILE})`));
  log(dim("  Version:  ") + `CLI ${VERSION}`);
  log(dim("  Repo:     ") + REPO);
  log("");
}

async function cmdWhoami({ json = false } = {}) {
  const u = await api("/user");
  if (json) { emitJSON(u); return; }
  log("");
  log(dim("  Email:   ") + sanitize(u.email || ""));
  log(dim("  Name:    ") + sanitize(u.display_name || ""));
  log(dim("  Type:    ") + (u.account_type || ""));
  log(dim("  Key:     ") + (u.key_scheme === "client" ? green("client-side (E2EE)") : "server-side"));
  log("");
}

function cmdVersion() {
  log(`${APP_NAME} CLI v${VERSION}`);
}

async function cmdUpdate() {
  try {
    const meta = await (await fetchT(`${currentBase()}/api/cli/version`, {}, 8000)).json();
    if (!meta.version) throw new Error("bad manifest");
    if (meta.version === VERSION) {
      log(green("  You're on the latest version.") + dim(" (v" + VERSION + ")"));
      return;
    }
    log(yellow(`  A new version is available: v${meta.version} (you have v${VERSION}).`));
    if (meta.changelog) log(dim("  " + meta.changelog));
    log(dim(`  Update with: npm i -g nova-mail-cli   ·   or ${meta.url || REPO}`));
  } catch {
    log(dim("  Could not check for updates."));
  }
}

async function checkForUpdates() {
  try {
    const meta = await (await fetchT(`${currentBase()}/api/cli/version`, {}, 8000)).json();
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
  return { provider: (readConfig().ai && readConfig().ai.provider) || "", key: getAiKey() };
}

async function aiSettingsFromServer() {
  const res = await fetchT(`${currentBase()}/api/ai/settings`, {
    headers: { Authorization: `Bearer ${getToken()}`, "User-Agent": UA },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not read AI settings");
  return res.json();
}

function aiMasterPrompt(cfg, aiToken) {
  const base = currentBase();
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
  const base = currentBase();
  const authHeader = p.auth.replace("<KEY>", key);
  return [
    "curl -sS " + p.base + "/chat/completions \\",
    '  -H "Content-Type: application/json" \\',
    `  -H "${authHeader}" \\`,
    "  -d '{",
    '    "model": "' + p.model + '",',
    '    "max_tokens": 1000,',
    '    "messages": [{',
    '      "role": "user",',
    '      "content": "You are a helpful email assistant bridged to NOVA Mail. " +',
    '        "Endpoint: ' + base + '/api/ai. Auth: x-ai-token header. Read mail, draft replies, submit for approval."',
    "    }]",
    "  }'",
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
  } else {
    headers["Authorization"] = `Bearer ${key}`;
  }
  const res = await fetchT(`${p.base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = (j.error && (j.error.message || j.error)) || msg; } catch { /* ignore */ }
    throw new Error(`${p.label} rejected the key/request: ${msg}`);
  }
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "OK";
}

/* ------------------------------------------------------------------ *
 *  Interactive shell
 * ------------------------------------------------------------------ */
async function interactiveShell() {
  requireAuth();
  bootScreen("Interactive mode · press q to quit a menu");

  for (;;) {
    const menu = [
      "📥  Inbox (list messages)",
      "✉️   Read a message",
      "📤  Compose & send",
      "🔎  Search",
      "📁  Folders",
      "🤖  AI agent (experimental, NOT recommended)",
      "📊  Status",
      "🚪  Log out",
      "❌  Exit",
    ];
    const choice = await choose(menu, "NOVA — main menu");
    if (choice < 0) continue;
    switch (choice) {
      case 0: await intMailbox(); break;
      case 1: await intRead(); break;
      case 2: await intSend(); break;
      case 3: await intSearch(); break;
      case 4: await withSpinner("Loading folders", () => cmdFolders()); await pauseScreen(); break;
      case 5: await intAI(); break;
      case 6: await withSpinner("Checking status", () => cmdStatus()); await pauseScreen(); break;
      case 7:
        clearAuth();
        log(green("  Logged out."));
        log(dim(`  Run \`nova login\` to come back.`));
        return;
      case 8:
        log(green("  Goodbye."));
        return;
    }
  }
}

async function intMailbox() {
  const folders = await withSpinner("Loading inbox", () => getFolders());
  const inbox = folders.find((f) => f.type === "inbox") || folders[0];
  const page = await withSpinner("Loading messages", () => listPage(inbox.id, { limit: 100 }));
  const messages = page.messages;
  if (messages.length === 0) {
    log(dim("  Inbox is empty."));
    await pauseScreen();
    return;
  }
  const labels = messages.map((m) => {
    const t = timeAgo(m.timestamp);
    const s = truncate(displaySender(m), 26);
    const st = (m.flags & 2) === 2 ? "★ " : "  ";
    return `${(m.flags & 1) === 0 ? "●" : " "} ${st}${padEndW(s, 26)} ${padStartW(t, 8)}  ·  ${truncate(sanitize(m.subject || m.preview || ""), 30)}`;
  });
  const idx = await choose(labels, "Inbox — pick a message");
  if (idx < 0) return;
  await cmdRead(messages[idx].id, { markRead: false });
  await pauseScreen();
}

async function intRead() {
  const id = await readLine("  Message id (or short id):  ");
  if (!id.trim()) return;
  try {
    await withSpinner("Fetching message", () => cmdRead(id.trim()));
  } catch (e) {
    err(e.message);
  }
  await pauseScreen();
}

async function intSearch() {
  const q = await readLine("  Search:  ");
  if (!q.trim()) return;
  try {
    await withSpinner("Searching", () => cmdSearch(q.trim()));
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
  if (choice === 0) {
    const provNames = Object.keys(AI_PROVIDERS).map((k) => AI_PROVIDERS[k].label);
    const pIdx = await choose(provNames, "Choose a provider");
    if (pIdx < 0) return;
    const provider = Object.keys(AI_PROVIDERS)[pIdx];
    const key = await readLine(`  ${AI_PROVIDERS[provider].label} API key (hidden):  `, { echo: (s) => "•".repeat(s.length) });
    if (!key.trim()) { log(dim("  Aborted.")); return; }
    saveAi(provider, key.trim());
    log(green("  Saved. ") + dim("Your key is encrypted at rest in ~/.nova/config.json."));
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
    } catch { /* ignore */ }
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
      await fetchT(`${currentBase()}/api/ai/auto-approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}`, "User-Agent": UA },
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
      await fetchT(`${currentBase()}/api/ai/disable`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}`, "User-Agent": UA },
      });
      log(green("  AI bridge disabled. Token revoked."));
    } catch (e) {
      err(e.message);
    }
    await pauseScreen();
    return;
  }
  // choice 6 = back
}

/* ------------------------------------------------------------------ *
 *  Arg parsing + dispatch
 * ------------------------------------------------------------------ */
const VALUE_FLAGS = new Set(["--to", "-t", "--subject", "-s", "--body", "-b", "--message", "-m", "--body-file", "--file", "--cc", "--bcc", "--base", "--api", "--limit", "-n", "--folder", "-f"]);
const BOOL_FLAGS = new Set(["--no-color", "--json", "--html", "--permanent", "--all", "--no-mark-read", "-h", "--help", "-v", "--version"]);

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      flags[a.slice(0, eq)] = a.slice(eq + 1);
      continue;
    }
    if (VALUE_FLAGS.has(a)) { flags[a] = argv[++i]; continue; }
    if (BOOL_FLAGS.has(a)) { flags[a] = true; continue; }
    if (a.startsWith("-") && a.length > 1) { flags[a] = true; continue; }
    pos.push(a);
  }
  return { flags, pos };
}

function readAllStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(""); return; }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { data += d; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.resume();
  });
}

const HELP = `
${KEY} ${bold("Mail CLI")}  v${VERSION}   ·   Open source: ${REPO}

${bold("Usage:")}
  nova                       Open the interactive menu
  nova <command> [options]   Run a one-shot command

${bold("Commands:")}
  login                      Sign in with your browser
  logout                     Remove the saved session
  mailbox [folder]           List messages (default: Inbox)
  folders                    List folders + unread counts
  read <message-id>          Show a message (marks it read; --no-mark-read to skip)
  send --to A --subject S --body B [--cc C --bcc D] [--html]
  search <query>             Search messages (--folder <name> to scope)
  mark <id> read|unread|star|unstar
  move <id> <folder>         Move a message to a folder
  delete <message-id> [--permanent]   Move to trash (or delete for good)
  status                     Show account + connection status
  whoami                     Show your account details
  ai                         AI agent helpers (EXPERIMENTAL · NOT RECOMMENDED)
  version                    Show CLI version
  update                     Check for the latest version
  help                       Show this help

${bold("Options:")}
  --base <url>               Custom NOVA base URL (default ${DEFAULT_BASE})
  --limit <n>                Rows for mailbox/search (default 25)
  --all                      Fetch every page (mailbox)
  --json                     Machine-readable output
  --body-file <path>         Read the body from a file ("-" = stdin)
  --no-color                 Disable colors

${bold("AI (experimental, not recommended):")}
  nova ai setup              Choose OpenAI / Anthropic / NVIDIA + enter API key
  nova ai test               Verify your provider key
  nova ai prompt             Print the master prompt for your BYO agent
  nova ai curl [provider]    Print a ready-to-run curl connect command

${bold("Security:")}
  Secrets are encrypted at rest (AES-256-GCM) in ~/.nova/config.json;
  the wrapping key lives in ~/.nova/key (mode 0600). Sign out with \`nova logout\`.
`;

async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));

  if (flags["--no-color"]) process.env.NO_COLOR = "1";

  const baseOverride = flags["--base"] || flags["--api"];
  if (baseOverride) {
    try { setBase(baseOverride); }
    catch (e) { err(e.message); return; }
  }

  const cmd = pos[0];

  if (!cmd || cmd === "run" || cmd === "menu" || cmd === "interactive") {
    try { requireAuth(); } catch {
      bootScreenNonInteractive("Interactive mode");
      const ok = await login();
      if (!ok) return;
    }
    await interactiveShell();
    return;
  }

  if (cmd === "help" || flags["-h"] || flags["--help"]) { log(HELP.trim()); return; }
  if (cmd === "version" || flags["-v"] || flags["--version"]) { cmdVersion(); return; }

  const authCommands = new Set(["mailbox", "folders", "read", "send", "search", "mark", "move", "delete", "status", "whoami"]);
  const known = new Set([...authCommands, "login", "logout", "update", "ai"]);
  if (!known.has(cmd)) { err(`Unknown command: ${cmd}. Run \`nova --help\`.`); return; }

  const json = !!flags["--json"];
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const spin = (label, fn) => (json || !interactive ? fn() : withSpinner(label, fn));

  if (authCommands.has(cmd)) { try { requireAuth(); } catch { return; } }

  if (!json) bootScreenNonInteractive("Connected · type `nova` for the interactive menu");

  try {
    switch (cmd) {
      case "login": {
        const ok = await login();
        if (ok) {
          log(green("  Authenticated as ") + bold(readConfig().email || "your account"));
          log(dim("  Run `nova` for the interactive menu."));
        } else {
          err("Sign-in incomplete.");
        }
        break;
      }
      case "logout": { clearAuth(); log(green("  Logged out.")); break; }
      case "mailbox": {
        const folder = flags["--folder"] || flags["-f"] || pos[1];
        const limit = parseInt(flags["--limit"] || flags["-n"] || "25", 10) || 25;
        await spin("Loading mailbox", () => cmdMailbox(folder, { all: !!flags["--all"], limit, json }));
        break;
      }
      case "folders": await spin("Loading folders", () => cmdFolders({ json })); break;
      case "read": {
        const id = pos[1];
        if (!id) { err("Usage: nova read <message-id>"); break; }
        await spin("Fetching message", () => cmdRead(id, { json, markRead: !flags["--no-mark-read"] }));
        break;
      }
      case "send": {
        const to = flags["--to"] || flags["-t"] || pos[1];
        const subject = flags["--subject"] || flags["-s"] || pos[2];
        let body = flags["--body"] || flags["-b"] || flags["--message"] || flags["-m"];
        const bodyFile = flags["--body-file"] || flags["--file"];
        if (bodyFile) {
          body = bodyFile === "-" ? await readAllStdin() : fs.readFileSync(bodyFile, "utf8");
        } else if (body === undefined && !process.stdin.isTTY) {
          body = await readAllStdin();
        }
        await spin("Sending", () => cmdSend(to, subject, body, {
          cc: flags["--cc"], bcc: flags["--bcc"], html: !!flags["--html"],
        }));
        break;
      }
      case "search": {
        const q = pos.slice(1).join(" ");
        const folder = flags["--folder"] || flags["-f"] || "";
        const limit = parseInt(flags["--limit"] || flags["-n"] || "25", 10) || 25;
        await spin("Searching", () => cmdSearch(q, { json, limit, folder }));
        break;
      }
      case "mark": {
        const id = pos[1];
        const action = pos[2];
        if (!id || !action) { err("Usage: nova mark <id> read|unread|star|unstar"); break; }
        await spin("Updating", () => cmdMark(id, action));
        break;
      }
      case "move": {
        const id = pos[1];
        const folder = pos[2];
        if (!id || !folder) { err("Usage: nova move <id> <folder>"); break; }
        await spin("Moving", () => cmdMove(id, folder));
        break;
      }
      case "delete": {
        const id = pos[1];
        if (!id) { err("Usage: nova delete <message-id> [--permanent]"); break; }
        await spin("Deleting", () => cmdDelete(id, { permanent: !!flags["--permanent"] }));
        break;
      }
      case "status": await spin("Checking status", () => cmdStatus({ json })); break;
      case "whoami": await spin("Loading account", () => cmdWhoami({ json })); break;
      case "update": await cmdUpdate(); break;
      case "ai": {
        const sub = pos[1] || "menu";
        if (sub === "setup") {
          aiBanner();
          const provNames = Object.keys(AI_PROVIDERS).map((k) => AI_PROVIDERS[k].label);
          const pIdx = await choose(provNames, "Choose a provider (experimental)");
          if (pIdx < 0) break;
          const provider = Object.keys(AI_PROVIDERS)[pIdx];
          const key = await readLine(`  ${AI_PROVIDERS[provider].label} API key:  `);
          if (!key.trim()) { log(dim("  Aborted.")); break; }
          saveAi(provider, key.trim());
          log(green("  Saved (encrypted at rest)."));
        } else if (sub === "test") {
          aiBanner();
          const ai = getAI();
          if (!ai.provider || !ai.key) { err("No provider configured. Run `nova ai setup` first."); break; }
          try {
            const out = await spin(`Testing ${AI_PROVIDERS[ai.provider].label} key`, () => aiTest(ai.provider, ai.key));
            log(green("  Key works.") + (out ? dim(` (model said: ${out})`) : ""));
          } catch (e) { err(e.message); }
        } else if (sub === "prompt") {
          aiBanner();
          log("\n" + aiMasterPrompt(readConfig(), "<your-ai-token>") + "\n");
        } else if (sub === "curl") {
          aiBanner();
          const ai = getAI();
          const provider = pos[2] || ai.provider || "openai";
          if (!AI_PROVIDERS[provider]) { err(`Unknown provider '${provider}'.`); break; }
          log("\n" + aiCurlCommand(readConfig(), provider, "[YOUR_SERVER_TOKEN]") + "\n");
        } else {
          log(HELP.trim());
        }
        break;
      }
      default:
        err(`Unknown command: ${cmd}. Run \`nova --help\`.`);
    }
  } catch (e) {
    if (e && e.message === "not-authenticated") return;
    err(e && e.message ? e.message : e);
  }

  if (cmd !== "login" && cmd !== "ai" && !json) checkForUpdates();
}

main();
