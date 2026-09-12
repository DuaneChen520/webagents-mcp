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

const controls = ['dsDeepThink', 'dsSearch', 'qwenMode'];

async function load() {
  const st = await chrome.storage.local.get(KEY);
  const d = st[KEY] || {};
  controls.forEach((id) => {
    const c = bindSeg(id);
    if (!c) return;
    const v = id === 'qwenMode' ? (d.qwenMode || '') : (d[id] === true ? 'on' : d[id] === false ? 'off' : '');
    c.set(v);
  });
}

function readSeg(id) {
  const seg = document.getElementById(id);
  const btn = [...seg.querySelectorAll('button')].find((b) => b.classList.contains('active'));
  return btn ? btn.dataset.value : '';
}

async function save() {
  const tri = (id) => (readSeg(id) === 'on' ? true : readSeg(id) === 'off' ? false : null);
  const d = {
    dsDeepThink: tri('dsDeepThink'),
    dsSearch: tri('dsSearch'),
    qwenMode: readSeg('qwenMode') || null,
  };
  await chrome.storage.local.set({ [KEY]: d });
  const s = document.getElementById('status');
  s.classList.add('show');
  setTimeout(() => s.classList.remove('show'), 1500);
}

document.addEventListener('DOMContentLoaded', load);
document.getElementById('save').addEventListener('click', save);
