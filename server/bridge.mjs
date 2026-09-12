#!/usr/bin/env node
/**
 * WEBAGENTS-bridge — 单例 WS 桥接（唯一持有 8765 端口的进程）
 *
 * 角色路由：
 *   - ext  ：WEBAGENTS Edge 扩展（唯一的扩展连接，新连接顶掉旧的）
 *   - mcp  ：一个或多个 MCP server 实例（Trae 会话、测试客户端可共存）
 *
 * 消息流：mcp 发 request{id,...} → 转发给 ext；ext 回 result{id,...} → 按 id 路由回发起的 mcp。
 */
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.WEBAGENTS_PORT || 8765);
const TOKEN = process.env.WEBAGENTS_TOKEN || 'webagents-local';

let ext = null;               // 扩展连接
const clients = new Set();    // mcp 客户端连接
const routes = new Map();     // request id -> 发起它的 mcp 连接

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
console.error(`[WEBAGENTS-bridge] listening on ws://127.0.0.1:${PORT}`);

wss.on('connection', (ws) => {
  let role = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'hello') {
      if (msg.token !== TOKEN) {
        ws.send(JSON.stringify({ type: 'hello-fail', error: 'token 不匹配' }));
        return ws.close();
      }
      role = msg.role === 'mcp' ? 'mcp' : 'ext';
      if (role === 'ext') {
        if (ext && ext !== ws) { try { ext.close(); } catch {} }
        ext = ws;
        console.error('[WEBAGENTS-bridge] 扩展已接入');
      } else {
        clients.add(ws);
      }
      ws.send(JSON.stringify({ type: 'hello-ok', role }));
      return;
    }

    if (!role) return;

    if (role === 'mcp' && msg.type === 'request') {
      if (!ext || ext.readyState !== 1) {
        return ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: 'WEBAGENTS 扩展未连接（请在 Edge 中确认扩展已启用且浏览器已打开）' }));
      }
      routes.set(msg.id, ws);
      ext.send(JSON.stringify(msg));
      return;
    }

    if (role === 'ext' && msg.type === 'result') {
      const client = routes.get(msg.id);
      if (client && client.readyState === 1) client.send(JSON.stringify(msg));
      routes.delete(msg.id);
      return;
    }
    // ping 等其它消息直接忽略
  });

  ws.on('close', () => {
    if (role === 'ext' && ext === ws) {
      ext = null;
      console.error('[WEBAGENTS-bridge] 扩展断开连接');
    }
    clients.delete(ws);
    for (const [id, c] of routes) if (c === ws) routes.delete(id);
  });

  ws.on('error', () => {});
});
