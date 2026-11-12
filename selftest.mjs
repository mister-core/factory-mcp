/**
 * factory_mcp 端到端自检：起一个真的 MCP 子进程，按协议逐步验证。
 * 用法：node selftest.mjs [config.json 路径]
 * 关注点：① 协议握手 ② 工具发现 ③ 真实数据源查询 ④ 只读防线 ⑤ 数据源不可达时错误可读且进程不崩
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const cfgPath = process.argv[2] || fileURLToPath(new URL('./config.selftest.json', import.meta.url));
const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));

const results = [];
const ok = (n, d = '') => { results.push({ n, pass: true, d }); console.log(`  ✓ ${n}${d ? '  ' + d : ''}`); };
const bad = (n, d = '') => { results.push({ n, pass: false, d }); console.log(`  ✗ ${n}  ${d}`); };

class Rpc {
  constructor(child) {
    this.child = child; this.seq = 0; this.pending = new Map(); this.stderr = '';
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let msg; try { msg = JSON.parse(line); } catch { return; }
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p(msg); }
    });
    child.stderr.on('data', (d) => { this.stderr += d.toString(); });
  }
  request(method, params, timeoutMs = 25000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`请求超时(${timeoutMs}ms): ${method}`)); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    });
  }
  notify(method, params) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n'); }
}
const firstText = (m) => m?.result?.content?.[0]?.text ?? '';
const asJson = (m) => { try { return JSON.parse(firstText(m)); } catch { return null; } };

console.log(`\n=== factory_mcp 自检 ===\n配置文件: ${cfgPath}\n`);

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, FACTORY_MCP_CONFIG: cfgPath, MCP_DEMO: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const rpc = new Rpc(child);

try {
  // 1) 握手
  const init = await rpc.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } });
  init?.result?.serverInfo?.name === 'factory-bridge'
    ? ok('initialize 握手', `${init.result.serverInfo.name} v${init.result.serverInfo.version} / protocol ${init.result.protocolVersion}`)
    : bad('initialize 握手', JSON.stringify(init).slice(0, 200));
  rpc.notify('notifications/initialized');

  // 2) 工具发现
  const tl = await rpc.request('tools/list');
  const tools = tl?.result?.tools || [];
  const names = tools.map((t) => t.name);
  tools.length > 0 ? ok('tools/list 工具发现', `${tools.length} 个工具`) : bad('tools/list 工具发现', '0 个');
  console.log(`      工具: ${names.join(', ')}`);

  // 每个工具都必须有 description 与 inputSchema（否则模型不会用/用错）
  const noDesc = tools.filter((t) => !t.description || !t.inputSchema);
  noDesc.length === 0 ? ok('每个工具都有 description + inputSchema') : bad('工具元数据不全', noDesc.map((t) => t.name).join(','));

  // 3) demo 工具（协议链路本身）
  const echo = await rpc.request('tools/call', { name: 'demo_echo', arguments: { text: '你好', n: 7 } });
  asJson(echo)?.echo?.n === 7 ? ok('tools/call 参数传递', JSON.stringify(asJson(echo).echo)) : bad('tools/call 参数传递', firstText(echo).slice(0, 200));

  // 4) 未知工具必须回可读错误，而不是崩
  const unk = await rpc.request('tools/call', { name: 'no_such_tool', arguments: {} });
  unk?.error?.message ? ok('未知工具返回可读错误', unk.error.message.slice(0, 60) + '…') : bad('未知工具', JSON.stringify(unk).slice(0, 200));

  // 5) MySQL 连接池 provider
  const poolTool = names.find((n) => n.endsWith('_pool'));
  if (poolTool) {
    const p = asJson(await rpc.request('tools/call', { name: poolTool, arguments: {} }));
    p?.ok ? ok(`${poolTool} 连接池自检`, `${p.pool?.free ?? '?'} 空闲/${p.pool?.total ?? '?'} 总连接, 库=${p.server?.current_db} v${p.server?.version}`)
          : bad(`${poolTool} 连接池自检`, p?.error || firstText(await rpc.request('tools/call', { name: poolTool, arguments: {} })).slice(0, 200));
  } else {
    console.log('  - 没有配置 MySQL 数据源，跳过连接池检查');
  }

  // 6) 真实查询：表清单 + SELECT
  const tablesTool = names.find((n) => n.endsWith('_tables'));
  if (tablesTool) {
    const t = asJson(await rpc.request('tools/call', { name: tablesTool, arguments: {} }));
    t?.total > 0 ? ok(`${tablesTool} 列出库表`, `${t.total} 张表`) : bad(`${tablesTool} 列出库表`, JSON.stringify(t).slice(0, 200));
  }
  const queryTool = names.find((n) => n.startsWith('db_') && n.endsWith('_query'));
  if (queryTool) {
    const q = asJson(await rpc.request('tools/call', { name: queryTool, arguments: { sql: 'SELECT * FROM mcp_selftest_parts ORDER BY id', limit: 5 } }));
    q?.rowCount >= 3 ? ok(`${queryTool} 真实 SELECT`, `返回 ${q.rowCount} 行 / ${q.elapsed_ms}ms，列: ${(q.columns || []).join(',')}`)
                     : bad(`${queryTool} 真实 SELECT`, JSON.stringify(q).slice(0, 300));

    // 7) 只读防线：写语句必须被拒
    const w = await rpc.request('tools/call', { name: queryTool, arguments: { sql: "DELETE FROM mcp_selftest_parts WHERE id=1" } });
    w?.error?.message ? ok('写语句被拒绝', w.error.message.slice(0, 70) + '…') : bad('写语句被拒绝', '竟然没报错: ' + firstText(w).slice(0, 200));

    // 8) 不存在的表必须被拒（表白名单）
    const nt = await rpc.request('tools/call', { name: queryTool, arguments: { sql: 'SELECT * FROM no_such_table_xyz' } });
    nt?.error?.message ? ok('不存在的表被拒绝', nt.error.message.slice(0, 60) + '…') : bad('不存在的表被拒绝', firstText(nt).slice(0, 200));

    // 9) 行数上限必须生效
    const lim = asJson(await rpc.request('tools/call', { name: queryTool, arguments: { sql: 'SELECT * FROM mcp_selftest_parts', limit: 2 } }));
    lim?.rowCount === 2 && lim?.truncated === true ? ok('行数上限生效', `rowCount=${lim.rowCount} truncated=${lim.truncated}`) : bad('行数上限', JSON.stringify(lim).slice(0, 200));
  }

  // 10) 不可达的数据源：错误必须可读，且进程不能崩
  const offline = names.find((n) => n === 'mes_status');
  if (offline) {
    const s = asJson(await rpc.request('tools/call', { name: offline, arguments: {} }));
    s && s.ok === false && typeof s.error === 'string'
      ? ok('不可达数据源返回可读错误', s.error.slice(0, 90) + '…')
      : bad('不可达数据源', JSON.stringify(s).slice(0, 250));
  }
  const alive = await rpc.request('ping');
  alive?.result !== undefined ? ok('错误之后进程存活（ping 正常）') : bad('错误之后进程存活', JSON.stringify(alive).slice(0, 120));

  // 11) 资源（数据字典）
  const rl = await rpc.request('resources/list');
  const res = rl?.result?.resources || [];
  res.length ? ok('resources/list', `${res.length} 个资源: ${res.map((r) => r.name).join(', ')}`) : bad('resources/list', '0 个资源');
  if (res.length) {
    const rd = await rpc.request('resources/read', { uri: res[0].uri });
    const txt = rd?.result?.contents?.[0]?.text || '';
    txt.length > 50
      ? ok('resources/read 取到数据字典', `${res[0].uri} → ${txt.length} 字符，首行: ${txt.split('\n')[0].slice(0, 50)}`)
      : bad('resources/read 数据字典', JSON.stringify(rd).slice(0, 200));
  }
} catch (e) {
  bad('自检异常', String(e?.message || e));
} finally {
  child.stdin.end();
  setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 300);
}

await new Promise((r) => setTimeout(r, 600));
const pass = results.filter((r) => r.pass).length;
console.log(`\n=== ${pass}/${results.length} 通过 ===`);
if (pass !== results.length) {
  console.log('失败项：' + results.filter((r) => !r.pass).map((r) => r.n).join(' / '));
  if (rpc.stderr) console.log('--- 服务端 stderr ---\n' + rpc.stderr.slice(-2000));
  process.exit(1);
}
process.exit(0);
