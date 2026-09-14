/** WebAgents 设置（popup / options 共用）：读写用户默认开关（chrome.storage.local 'userDefaults'） */
const KEY = 'userDefaults';

// 三态分段控件：值存 'on' | 'off' | 'fast' | 'think' | ''（默认=不干预）
function bindSeg(id) {
  const seg = document.getElementById(id);
  if (!seg) return null;
  const buttons = [...seg.querySelectorAll('button')];
  const get = () => (buttons.find((b) => b.classList.contains('active')) || {}).dataset.value ?? '';
  const set = (v) => buttons.forEach((b) => b.classList.toggle('active', b.dataset.value === v));
  buttons.forEach((b) => b.addEventListener('click', () => set(b.dataset.value)));
  return { get, set };
}

const controls = ['dsDeepThink', 'dsSearch', 'qwenMode', 'throttleSec'];

/** 各类控件的初始选中值（throttleSec 缺省为 3 秒） */
function initialSeg(id, d) {
  if (id === 'qwenMode') return d.qwenMode || '';
  if (id === 'throttleSec') return String(typeof d.throttleSec === 'number' ? d.throttleSec : 3);
  return d[id] === true ? 'on' : d[id] === false ? 'off' : '';
}

async function load() {
  const st = await chrome.storage.local.get(KEY);
  const d = st[KEY] || {};
  controls.forEach((id) => {
    const c = bindSeg(id);
    if (c) c.set(initialSeg(id, d));
  });
}

function readSeg(id) {
  const seg = document.getElementById(id);
  if (!seg) return '';   // 页面缺该控件时按"未设置"处理，避免点保存直接抛错
  const btn = [...seg.querySelectorAll('button')].find((b) => b.classList.contains('active'));
  return btn ? btn.dataset.value : '';
}

async function save() {
  const tri = (id) => (readSeg(id) === 'on' ? true : readSeg(id) === 'off' ? false : null);
  const d = {
    dsDeepThink: tri('dsDeepThink'),
    dsSearch: tri('dsSearch'),
    qwenMode: readSeg('qwenMode') || null,
    // 未选中任何档位时回落到默认 3 秒（保证「点保存」不会意外把节流变成 0/NaN）
    throttleSec: Number(readSeg('throttleSec') || 3) || 0,
  };
  await chrome.storage.local.set({ [KEY]: d });
  const s = document.getElementById('status');
  s.classList.add('show');
  setTimeout(() => s.classList.remove('show'), 1500);
}

document.addEventListener('DOMContentLoaded', load);
document.getElementById('save').addEventListener('click', save);

// ---- 「调试」权限：按需授予 ----
//
// 为什么要用户点一下才给：chrome.permissions.request() 属于"需要用户手势"的 API，
// 后台无法静默申请。因此权限只能从这个按钮授予，报错信息也会指到这里。
const dbgStateEl = () => document.getElementById('debugState');

function paintDebug(has) {
  const el = dbgStateEl();
  if (!el) return;
  el.textContent = has ? '已授权' : '未授权（跑千问前请先授予）';
  el.classList.toggle('ok', !!has);
}

async function refreshDebug() {
  try {
    const has = await chrome.permissions.contains({ permissions: ['debugger'] });
    paintDebug(has);
  } catch { paintDebug(false); }
}

{
  const grant = document.getElementById('grantDebug');
  if (grant) {
    grant.addEventListener('click', async () => {
      if (!chrome.permissions || !chrome.permissions.request) return paintDebug(false);
      try {
        // 必须在点击回调里直接调用，否则浏览器会拒绝（无用户手势）
        const granted = await chrome.permissions.request({ permissions: ['debugger'] });
        paintDebug(granted);
      } catch { paintDebug(false); }
    });
  }
  const revoke = document.getElementById('revokeDebug');
  if (revoke) {
    revoke.addEventListener('click', async () => {
      try { await chrome.permissions.remove({ permissions: ['debugger'] }); } catch { /* 忽略 */ }
      refreshDebug();
    });
  }
  if (dbgStateEl()) refreshDebug();
}
