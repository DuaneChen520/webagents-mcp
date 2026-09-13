/**
 * WebAgents — background service worker
 *
 * 职责：
 * 1. 维持与本地 WS 桥接（ws://127.0.0.1:8765）的连接，掉线自动重连
 * 2. 接收 request{action, site, prompt...}，路由到对应站点的 content script 适配器
 * 3. 管理每站一个专属（pinned）标签页：不存在则创建；已存在则原地唤醒复用当前会话（不导航）
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
    // 注：部分 Edge 版本 tabs.create 不接受 autoDiscardable，创建后单独用 update 设置
    tab = await chrome.tabs.create({ url: cfg.url, pinned: true, active: false });
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (err) { console.log(`[webagents] ${site} 防休眠设置失败: ${err.message}`); }
  } else {
    // 唤醒休眠标签页 + 防止被 Edge 休眠；不导航（保留当前会话，2026-09-14 去掉“归位首页”）
    try {
      if (tab.discarded) await chrome.tabs.reload(tab.id); // 丢弃态先原地唤醒，保持会话 URL
      try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (err2) { console.log(`[webagents] ${site} 防休眠设置失败: ${err2.message}`); }
    } catch (err) {
      console.log(`[webagents] ${site} 标签页唤醒失败 tabId=${tab.id}: ${err.message}`);
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
      // 不做归位校验/残留刷新（会打断会话）；旧回复误判由 ask 阶段的基线块数守卫处理
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
const SW_VERSION = '5'; // v5: 会话复用（去掉每次归位首页），基线块数守卫防旧回复误判
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
      // 两段式：先触发发送（容忍整页跳转），再由 SW 轮询页面状态直到回复稳定。
      // content 侧已做 inject（读回比对 ≤3s×2 次）/ send（等价信号 ≤5s）分级校验，
      // 这里只负责 no_site_feedback（≤12s）与回复稳定性判定。
      // ack 兜底 60s：content 最坏合法路径（长文本逐字符注入×2 次 + 选项切换）可能 ~50s，
      // 超时按 ack 丢失处理，绝不无限挂起等 sendMessage。
      const ack = await Promise.race([
        chrome.tabs.sendMessage(tabId, { type: 'ask', prompt: msg.prompt, options: effOptions }).catch(() => null),
        sleep(60000).then(() => null),
      ]);

      // ack 显式失败 = content 校验已确认失败 → 立即把错误传回 server/MCP，绝不静默重试
      if (ack && ack.ok === false) {
        const stage = ack.stage || 'unknown';
        const detail = ack.detail || ack.error || '未知错误';
        return sendResult(id, stamp({ ok: false, stage, detail, error: `[${site}][${stage}] ${detail}` }));
      }

      // SW 侧超时上限 170s：早于 WS 桥 180s 上限返回，超时带出已生成的部分文本
      const timeoutMs = msg.timeoutMs || 170000;
      const deadline = Date.now() + timeoutMs;
      let lastText = '';
      let lastCount = 0;
      let stableSince = 0;

      // 首反馈判定基线（ack 成功时由 content 回传）：发送完成瞬间的回答块数与思考态指示器
      const baseBlocks = (ack && ack.baseBlocks) || 0;
      const baseFeedback = (ack && ack.baseFeedback) || null;
      // 生命信号：回复文本出现 / 回答区新增节点 / 思考态或加载指示器（与基线对比）
      const hasSignal = (st) => (st.count > 0 && !!st.text)
        || (typeof st.blocks === 'number' && st.blocks > baseBlocks)
        || (!!st.feedback && st.feedback !== baseFeedback);

      if (!ack) {
        // ack 丢失/超时（页面跳转或消息通道中断）：给 12s 首反馈窗口，无任何生命信号立即报错
        const ackDeadline = Date.now() + 12000;
        let st0 = null;
        while (Date.now() < ackDeadline) {
          await sleep(1200);
          try { st0 = await chrome.tabs.sendMessage(tabId, { type: 'state' }); } catch { continue; }
          if (st0 && ((st0.count > 0 && st0.text) || st0.feedback)) break;
        }
        if (!(st0 && ((st0.count > 0 && st0.text) || st0.feedback))) {
          return sendResult(id, stamp({
            ok: false,
            stage: 'no_site_feedback',
            detail: 'ack 丢失且 12s 内无站点反馈，注入/发送未生效',
            error: `[${site}][no_site_feedback] ack 丢失且 12s 内无站点反馈，注入/发送未生效`,
          }));
        }
        lastText = st0.text || '';
        lastCount = st0.count || 0;
      }

      let gotSignal = !ack; // ack 丢失路径已在上方窗口确认过信号
      // 会话复用守卫：不再导航归位后，页面可能带旧回复；必须等到基线之外的新回答块才判完成
      let newBlockSeen = !ack;
      let noSignalMs = 0;
      while (true) {
        const loopStart = Date.now();
        if (Date.now() > deadline) {
          return sendResult(id, stamp({ ok: true, text: lastText, timedOut: true }));
        }
        await sleep(1500);

        let st = null;
        try {
          st = await chrome.tabs.sendMessage(tabId, { type: 'state' });
        } catch {
          continue; // 页面跳转中（content script 重建），不计入首反馈窗口，下一轮再取
        }
        if (!st || !st.ok) continue;
        if (typeof st.blocks === 'number' && st.blocks > baseBlocks) newBlockSeen = true;

        // 首反馈校验（≤12s）：发送成功后回复区必须出现任一生命信号，否则立即报错
        if (!gotSignal) {
          if (hasSignal(st)) {
            gotSignal = true;
          } else {
            noSignalMs += Date.now() - loopStart;
            if (noSignalMs >= 12000) {
              return sendResult(id, stamp({
                ok: false,
                stage: 'no_site_feedback',
                detail: `发送后回复区 ${Math.round(noSignalMs / 1000)}s 内无生命信号（无流式文本/思考态/新增节点）`,
                error: `[${site}][no_site_feedback] 发送后回复区 12s 内无生命信号（无流式文本/思考态/新增节点）`,
              }));
            }
          }
        }

        const { count, text } = st;
        const now = Date.now();
        if (newBlockSeen && count > 0 && text && text === lastText && count === lastCount) {
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
