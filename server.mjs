#!/usr/bin/env node
/**
 * factory-bridge —— 工厂系统「只读」MCP 服务器（零依赖，Node >= 18）
 * ---------------------------------------------------------------------------
 * 一个常驻进程，内部按 provider 分区接入多套系统（MES / PLM / OA / ...），
 * 每套系统只暴露三件事：connect（认证+连接池）、describe（元数据字典）、query（只读查询）。
 * 对外通过 MCP（JSON-RPC 2.0 over stdio）把 provider 的工具暴露给 Agent。
 *
 * 传输：stdio，一行一条 JSON 消息（不是 LSP 的 Content-Length 分帧）。
 * stdout 只走协议，日志一律走 stderr。
 *
 * 用法：
 *   node mcp/server.mjs                 # 正常模式（读 ../config.json 决定启用哪些 provider）
 *   MCP_DEMO=1 node mcp/server.mjs      # 额外加载 demo provider（协议自检用）
 *   node mcp/selftest.mjs               # 端到端自检
 */
import { loadProviders } from './providers/index.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'factory-bridge', version: '0.1.0' };
const MAX_TEXT = 180_000;          // 单次工具返回的字符上限，保护 Agent 上下文

const log = (...a) => process.stderr.write('[factory-bridge] ' + a.join(' ') + '\n');
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const rpcResult = (id, result) => send({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message, data) =>
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

/* ── 启动：加载所有 provider，聚合成工具表 ───────────────────────────────── */
const providers = await loadProviders();
const toolIndex = new Map();
const resourceIndex = new Map();

for (const p of providers) {
  for (const t of p.tools || []) {
    if (toolIndex.has(t.name)) { log(`工具名冲突，已跳过: ${t.name}（属于 ${p.id}）`); continue; }
    toolIndex.set(t.name, { ...t, provider: p });
  }
  for (const r of p.resources || []) {
    if (!resourceIndex.has(r.uri)) resourceIndex.set(r.uri, { ...r, provider: p });
  }
}
log(`已加载 ${providers.length} 个数据源、${toolIndex.size} 个工具、${resourceIndex.size} 个资源`);

const instructions = [
  '连接的是工厂业务系统（MES/PLM/OA）的**只读**数据。',
  '先看数据字典再查数据：mes_* 系列可用 mes_entity_list / mes_entity_fields 拿到实体与中文字段名、枚举值，',
  '不要猜字段名，也不要把 MES 内码（如 Status=7）当业务含义展示。',
  '所有查询都强制分页上限，请用条件收窄范围而不是拉全量。',
  '时间字段是 UTC ISO 串，展示时按 UTC+8 换算。',
].join('');

/* ── 工具 / 资源 ────────────────────────────────────────────────────────── */
function listTools() {
  return [...toolIndex.values()].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema || { type: 'object', properties: {} },
  }));
}

function listResources() {
  return [...resourceIndex.values()].map((r) => ({
    uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType || 'text/plain',
  }));
}

async function callTool(name, args) {
  const t = toolIndex.get(name);
  if (!t) {
    const known = [...toolIndex.keys()].join(', ');
    throw Object.assign(new Error(`未知工具 ${name}。可用工具: ${known}`), { rpcCode: -32602 });
  }
  const out = await t.provider.call(name, args || {});
  let text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
  const content = [];
  if (text.length > MAX_TEXT) {
    text = text.slice(0, MAX_TEXT);
    content.push({ type: 'text', text });
    content.push({ type: 'text', text: `⚠️ 结果超过 ${MAX_TEXT} 字符已截断。请收窄条件、减少字段或分页再来。` });
  } else {
    content.push({ type: 'text', text });
  }
  return { content };
}

async function readResource(uri) {
  const r = resourceIndex.get(uri);
  if (!r) {
    const known = [...resourceIndex.keys()].join(', ') || '（无）';
    throw Object.assign(new Error(`未知资源 ${uri}。可用资源: ${known}`), { rpcCode: -32602 });
  }
  const out = await r.provider.readResource(uri);
  const text = typeof out === 'string' ? out : out.text;
  return {
    contents: [{ uri, mimeType: (out && out.mimeType) || r.mimeType || 'text/plain', text: text.slice(0, MAX_TEXT) }],
  };
}

/* ── JSON-RPC 分发 ──────────────────────────────────────────────────────── */
async function handle(msg) {
  const { id, method, params } = msg;
  const hasId = id !== undefined && id !== null;

  // 通知（无 id）：不回包
  if (!hasId) {
    if (method === 'notifications/initialized') log('客户端已初始化');
    else log(`忽略通知: ${method}`);
    return;
  }

  try {
    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions,
        });
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: listTools() });
      case 'tools/call':
        return rpcResult(id, await callTool(params?.name, params?.arguments));
      case 'resources/list':
        return rpcResult(id, { resources: listResources() });
      case 'resources/read':
        return rpcResult(id, await readResource(params?.uri));
      case 'prompts/list':
        return rpcResult(id, { prompts: [] });
      case 'logging/setLevel':
        return rpcResult(id, {});
      default:
        return rpcError(id, -32601, `不支持的方法: ${method}`);
    }
  } catch (e) {
    // 工具内部错误 → 走 JSON-RPC error；MCP 客户端（含 Hermes）会把它作为可读错误交给模型
    const details = [];
    if (e && typeof e === 'object') for (const k of Object.getOwnPropertyNames(e)) if (!['stack', 'rpcCode'].includes(k)) details.push(`${k}=${e[k]}`);
    log(`工具执行失败 [${params?.name ?? method}]: ${e?.message}`);
    return rpcError(id, e?.rpcCode ?? -32000, String(e?.message ?? e), details.length ? details.join(' | ') : undefined);
  }
}

/* ── stdio 主循环 ───────────────────────────────────────────────────────── */
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { log(`丢弃非法 JSON 行: ${line.slice(0, 120)}`); continue; }
    handle(msg).catch((e) => log(`分发异常: ${e?.message}`));
  }
});
process.stdin.on('end', () => { log('stdin 关闭，退出'); process.exit(0); });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
