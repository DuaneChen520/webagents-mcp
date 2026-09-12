/**
 * WebAgents — background service worker
 *
 * 职责：
 * 1. 维持与本地 WS 桥接（ws://127.0.0.1:8765）的连接，掉线自动重连
 * 2. 接收 request{action, site, prompt...}，路由到对应站点的 content script 适配器
 * 3. 管理每站一个专属（pinned）标签页：不存在则创建，先归位到站点首页（保证全新会话），再派发
 *
 * 注意：内容脚本负责页面内的等待与抓取；SW 只做路由。WS 心跳保持 SW 存活。
 */

const WS_URL = 'ws://127.0.0.1:8765';
const TOKEN = 'webagents-local';

const SITES = {
  deepseek: {
    url: 'https://chat.deepseek.com/',
    matches: ['https://chat.deepseek.com/*'],
  },
  qwen: {
    url: 'https://www.qianwen.com/',
    matches: ['https://www.qianwen.com/*', 'https://qianwen.com/*', 'https://chat.qianwen.com/*'],
    legacyMatches: ['https://www.tongyi.com/*', 'https://tongyi.aliyun.com/*', 'https://chat.aliyun.com/*'],
    cdpInput: true, // 编辑器框架对合成事件免疫，用 chrome.debugger 派发可信输入
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- WS 连接（带重连退避）----
let ws = null;
let backoff = 1000;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    console.log('[webagents] WS 已连接');
    backoff = 1000;
    ws.send(JSON.stringify({ type: 'hello', role: 'ext', token: TOKEN }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'request') {
      handleRequest(msg).catch((err) =>
        sendResult(msg.id, { ok: false, error: err.message }),
      );
    }
  };
  ws.onclose = () => {
    console.log(`[webagents] WS 断开，${backoff}ms 后重连`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
  ws.onerror = () => ws.close();
}
connect();

// 心跳：保持 SW 存活（Chrome 116+ WS 活动会续命）
setInterval(() => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
}, 20000);

// SW 被 MV3 空闲回收后的自愈：alarm 周期唤醒并重连
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive' && (!ws || ws.readyState > 1)) {
    console.log('[webagents] alarm 触发重连');
    connect();
  }
});

function sendResult(id, payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'result', id, ...payload }));
  }
}

// ---- CDP 可信输入（chrome.debugger）：千问编辑器/菜单对合成事件免疫 ----
const dbgAttached = new Set();
chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) dbgAttached.delete(source.tabId);
});

async function cdpClick(tabId, x, y) {
  const target = { tabId };
  const attachedHere = !dbgAttached.has(tabId);
  if (attachedHere) await chrome.debugger.attach(target, '1.3');
  try {
    const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' };
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  } finally {
    // 用完立即断开，尽量缩短「正在调试」状态暴露时间，降低风控弹窗概率
    if (attachedHere) {
      try { await chrome.debugger.detach(target); } catch {}
      dbgAttached.delete(tabId);
    }
  }
}

// content script 请求在页面坐标 (x,y) 处执行一次真实点击
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'cdpClick' && sender.tab && sender.tab.id != null) {
    cdpClick(sender.tab.id, msg.x, msg.y)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // 异步 sendResponse
  }
  return false;
});

// ---- 站点标签页管理 ----
async function ensureTab(site) {
  const cfg = SITES[site];
  if (!cfg) throw new Error(`未知站点: ${site}`);

  let tabs = await chrome.tabs.query({ url: cfg.matches });
  if (!tabs.length && cfg.legacyMatches) {
    tabs = await chrome.tabs.query({ url: cfg.legacyMatches });
  }
  let tab = tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: cfg.url, pinned: true, active: false, autoDiscardable: false });
  } else {
    // 唤醒休眠标签页 + 防止被 Edge 休眠 + 归位首页（全新会话）
    try {
      await chrome.tabs.update(tab.id, { url: cfg.url, active: false, autoDiscardable: false });
    } catch (err) {
      console.log(`[webagents] ${site} 标签页归位失败 tabId=${tab.id}: ${err.message}`);
    }
  }

  // 等待页面加载完成且适配器就绪（最多 60s）
  // 策略：注入(第0轮) → 仍不通则强制刷新(第5轮) → 再注入(第15轮) → 再刷新(第29轮)
  let injected = false;
  let reloads = 0;
  let lastErr = '';
  for (let i = 0; i < 60; i++) {
    let r = null;
    try {
      r = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
    } catch (err) { lastErr = err.message; }
    if (r && r.ready) {
      // 归位校验：必须真的在首页（否则旧对话页也会 ready）；残留回复同样刷新
      let cur = null;
      try { cur = await chrome.tabs.get(tab.id); } catch {}
      const onHome = cur && cur.url && cur.url.startsWith(cfg.url);
      let st = null;
      try { st = await chrome.tabs.sendMessage(tab.id, { type: 'state' }); } catch {}
      const stale = st && st.ok && st.count > 0;
      if ((!onHome || stale) && reloads < 3) {
        reloads++;
        console.log(`[webagents] ${site} 未归位(onHome=${onHome})或残留回复(${stale ? st.count : 0}块)，刷新归位 url=${(cur && cur.url) || '未知'}`);
        try { await chrome.tabs.update(tab.id, { url: cfg.url, active: false }); } catch {}
        injected = false;
        await sleep(2000);
        continue;
      }
      return tab.id;
    }

    if (i === 5 || i === 29) {
      console.log(`[webagents] ${site} 第${i}轮仍不通，强制刷新标签页 tabId=${tab.id}`);
      try { await chrome.tabs.reload(tab.id); } catch {}
      injected = false;
      await sleep(3000);
      continue;
    }

    if (!injected && (i === 0 || i === 15)) {
      injected = true;
      console.log(`[webagents] ${site} 第${i}轮程序化补注入 tabId=${tab.id}`);
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/common.js', `content/${site}.js`],
        });
      } catch (err) {
        lastErr = `补注入失败: ${err.message}`;
      }
    }
    await sleep(1000);
  }
  throw new Error(
    `站点 ${site} 的适配器未就绪 | 找到标签页=${!!tab} tabUrl=${(tab && tab.url) || '无'} | ${lastErr || 'ping 无响应'}`
  );
}

// ---- 请求路由 ----
const SW_VERSION = '3'; // v3: options 支持（deepseek deepThink/search，qwen mode）
async function handleRequest(msg) {
  const { id, action } = msg;
  const stamp = (r) => Object.assign({ sw: SW_VERSION }, r);
  try {
    if (action === 'ping') {
      return sendResult(id, stamp({ ok: true, data: { connected: true } }));
    }

    const site = msg.site;
    if (!SITES[site]) return sendResult(id, stamp({ ok: false, error: `未知站点: ${site}` }));

    const tabId = await ensureTab(site);

    if (action === 'probe') {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'probe' });
      return sendResult(id, stamp(r || { ok: false, error: 'content script 无响应' }));
    }

    if (action === 'ask') {
      // 合并用户默认开关（扩展选项页设置）：面板设置优先级最高，覆盖显式 options；null/未设置 = 不干预页面开关
      let effOptions = msg.options || null;
      try {
        const st = await chrome.storage.local.get('userDefaults');
        const d = st.userDefaults || {};
        const defaults = {};
        if (d.dsDeepThink === true || d.dsDeepThink === false) defaults.deepThink = d.dsDeepThink;
        if (d.dsSearch === true || d.dsSearch === false) defaults.search = d.dsSearch;
        if (d.qwenMode) defaults.mode = d.qwenMode;
        if (Object.keys(defaults).length) effOptions = Object.assign({}, msg.options || {}, defaults);
      } catch { /* 存储不可用时按无默认处理 */ }
      // 两段式：先触发发送（立即返回，容忍整页跳转），再由 SW 轮询页面状态直到回复稳定
      let ack = null;
      try {
        ack = await chrome.tabs.sendMessage(tabId, { type: 'ask', prompt: msg.prompt, options: effOptions });
      } catch {
        // 发送瞬间页面可能已开始跳转，ack 丢失不算失败，继续轮询
      }
      // SW 侧超时上限 170s：早于 WS 桥 180s 上限返回，超时带出已生成的部分文本
      const timeoutMs = msg.timeoutMs || 170000;
      const deadline = Date.now() + timeoutMs;
      let lastText = '';
      let lastCount = 0;
      let stableSince = 0;

      if (ack && ack.ok === false) {
        // send 失败不立即判死：编辑器框架可能延迟处理，继续轮询 15s 看回复是否出现
        const graceEnd = Date.now() + 15000;
        let st = null;
        while (Date.now() < graceEnd) {
          await sleep(1500);
          try { st = await chrome.tabs.sendMessage(tabId, { type: 'state' }); } catch { continue; }
          if (st && st.ok && st.count > 0 && st.text) break;
        }
        if (!(st && st.ok && st.count > 0 && st.text)) {
          return sendResult(id, stamp(ack));
        }
        // 有回复了 → 进入下方的稳定性轮询，把 st 当作初始状态
        lastText = st.text;
        lastCount = st.count;
      }

      while (true) {
        if (Date.now() > deadline) {
          return sendResult(id, stamp({ ok: true, text: lastText, timedOut: true }));
        }
        await sleep(1500);

        let st = null;
        try {
          st = await chrome.tabs.sendMessage(tabId, { type: 'state' });
        } catch {
          continue; // 页面跳转中（content script 重建），下一轮再取
        }
        if (!st || !st.ok) continue;

        const { count, text } = st;
        const now = Date.now();
        if (count > 0 && text && text === lastText && count === lastCount) {
          if (!stableSince) stableSince = now;
          if (now - stableSince >= 800) {
            await sleep(500); // 复确认
            let re = null;
            try { re = await chrome.tabs.sendMessage(tabId, { type: 'state' }); } catch {}
            if (re && re.ok && re.text === text) {
              return sendResult(id, stamp({ ok: true, text, timedOut: false, options: re.options ?? null }));
            }
            if (re && re.ok) { lastText = re.text; lastCount = re.count; }
            stableSince = 0;
          }
        } else {
          stableSince = 0;
          lastText = text;
          lastCount = count;
        }
      }
    }

    return sendResult(id, stamp({ ok: false, error: `未知 action: ${action}` }));
  } catch (err) {
    sendResult(id, stamp({ ok: false, error: err.message }));
  }
}
