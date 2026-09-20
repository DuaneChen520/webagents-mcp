/** WebAgents 设置页：同一份 options.html 既当工具栏浮窗也当完整设置页；读写 chrome.storage.local 'userDefaults' */
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
