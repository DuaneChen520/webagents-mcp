#!/usr/bin/env node
/**
 * WEBAGENTS-store — 本地状态存储（令牌 + 运行记录）
 *
 * 为什么不放在仓库里：令牌是凭据，运行记录含 prompt 片段。
 * 两者都落在用户私有目录（Windows: %LOCALAPPDATA%\webagents，其它平台 ~/.local/share/webagents）。
 * 需要改位置时设 WEBAGENTS_HOME。
 *
 * 为什么令牌要落盘：桥是单例进程，可能由任意一条 CLI 命令（或驻留桥）拉起；
 * 令牌必须跨进程、跨重启保持一致，否则每个进程生成一个、互相连不上。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function appDir() {
  if (process.env.WEBAGENTS_HOME) return process.env.WEBAGENTS_HOME;
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'webagents');
}

export function ensureDir(dir = appDir()) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在或无权限 */ }
  return dir;
}

export const bridgeFile = () => path.join(appDir(), 'bridge.json');
export const runsFile = () => path.join(appDir(), 'runs.jsonl');

// ---- 桥接令牌 ----

export function loadBridgeState() {
  try {
    return JSON.parse(fs.readFileSync(bridgeFile(), 'utf8'));
  } catch { return null; }
}

export function saveBridgeState(state) {
  try {
    ensureDir();
    fs.writeFileSync(bridgeFile(), JSON.stringify(state, null, 2), { mode: 0o600 });
    return true;
  } catch { return false; }
}

/**
 * 取得当前令牌。
 *   env WEBAGENTS_TOKEN 优先（便于 CI / 临时调试）
 *   → 令牌文件
 *   → create=true 时随机生成并落盘
 *
 * 注意：这里**不再有硬编码的默认令牌**。旧实现把 'webagents-local' 写死在扩展和桥里，
 * 等于没有鉴权 —— 本机任何进程都能连上桥、借扩展的登录态发 prompt。
 */
export function resolveToken({ create = false } = {}) {
  if (process.env.WEBAGENTS_TOKEN) return { token: process.env.WEBAGENTS_TOKEN, source: 'env' };
  const st = loadBridgeState();
  if (st && typeof st.token === 'string' && st.token) return { token: st.token, source: 'file' };
  if (!create) return { token: null, source: 'none' };
  const token = crypto.randomBytes(24).toString('base64url');
  const prev = st || {};
  saveBridgeState({
    ...prev,
    token,
    pairedAt: null,
    pairedOrigin: null,
    createdAt: new Date().toISOString(),
  });
  return { token, source: 'generated' };
}

/** 记录扩展配对（TOFU：首次无令牌连接时发放令牌） */
export function markPaired(origin) {
  const st = loadBridgeState() || {};
  const isExt = typeof origin === 'string' && origin.startsWith('chrome-extension://');
  saveBridgeState({
    ...st,
    pairedAt: new Date().toISOString(),
    // 只在确实是扩展来源时才记来源；否则留 null，让扩展后续"认领"自己的身份
    pairedOrigin: isExt ? origin : null,
  });
}

/**
 * 判断一次"无令牌"的扩展连接是否允许配对。
 *
 * 放开到什么程度是个权衡：太严 → 扩展存储被清空后无法自愈；
 * 太松 → 本机任意进程只要抢先连一次就能拿到令牌。折中是**绑定来源**：
 * 首次配对是 TOFU（首次信任），此后只允许同一扩展来源重新配对。
 *
 * 注意"无来源记录"这一档：浏览器通常会给 WebSocket 带上
 * `Origin: chrome-extension://<id>`，但万一某个上下文不带，
 * 就不该让扩展永久装不上 —— 因此允许扩展来源来"认领"这次配对。
 */
export function canPair(origin) {
  const isExt = typeof origin === 'string' && origin.startsWith('chrome-extension://');
  const st = loadBridgeState() || {};
  if (!st.pairedAt) return true;        // 从未配对：允许首次配对
  if (!st.pairedOrigin) return isExt;   // 上次配对没记来源：允许扩展来认领
  return st.pairedOrigin === origin;    // 只认同一扩展来源
}

// ---- 运行记录 ----

const RUNS_MAX_LINES = 400;
const RUNS_MAX_BYTES = 512 * 1024;

/**
 * 追加一条运行记录（JSONL）。
 *
 * 价值：此前排障全靠"再跑一次看现象"，代价是每次都消耗一次真实问答 + 一次扩展重载。
 * 有了记录，多数问题可以直接从历史里看出趋势与差异。
 */
export function appendRun(entry) {
  try {
    ensureDir();
    const line = JSON.stringify({ ts: Date.now(), iso: new Date().toISOString(), ...entry });
    fs.appendFileSync(runsFile(), line + '\n');
  } catch { /* 记录失败绝不影响主流程 */ }
}

export function readRuns({ limit = 20, site, onlyErrors = false, kind } = {}) {
  let entries;
  try {
    entries = fs.readFileSync(runsFile(), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
  if (site) entries = entries.filter((e) => e.site === site);
  if (kind) entries = entries.filter((e) => e.kind === kind);
  if (onlyErrors) entries = entries.filter((e) => e.ok === false);
  const n = Math.max(1, Math.min(200, Number(limit) || 20));
  return entries.slice(-n);
}

/** 轮转：只在服务端启动时调用（避免多进程同时改写文件） */
export function rotateRuns() {
  try {
    const p = runsFile();
    const st = fs.statSync(p);
    let lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    if (st.size <= RUNS_MAX_BYTES && lines.length <= RUNS_MAX_LINES) return;
    lines = lines.slice(-Math.floor(RUNS_MAX_LINES / 2));
    fs.writeFileSync(p, lines.join('\n') + '\n');
  } catch { /* 文件不存在等无需处理 */ }
}
