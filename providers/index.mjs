/**
 * provider 装配：读 config.json，按系统逐个创建 provider。
 * 一个 provider = 一套外部系统 + 它的连接方式 + 它的工具集。
 * 新增一套系统（PLM/OA）= 新增一个 provider 文件 + config 里加一段，不动 server.mjs。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createU9Provider } from './u9_mes.mjs';
import { createMysqlProviders } from './mysql_ro.mjs';
import { createDcsHttpProvider } from './dcs_http.mjs';
import { createDemoProvider } from './demo.mjs';

const log = (m) => process.stderr.write('[factory-bridge] ' + m + '\n');

export const CONFIG_PATH = process.env.FACTORY_MCP_CONFIG
  || fileURLToPath(new URL('../config.json', import.meta.url));

export async function loadProviders() {
  let cfg = {};
  try {
    cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    log(`配置已加载: ${CONFIG_PATH}`);
  } catch (e) {
    if (e.code !== 'ENOENT') log(`读取配置失败 ${CONFIG_PATH}: ${e.message}`);
    log('没有 config.json —— 只加载 demo provider。把 config.example.json 复制成 config.json 并填连接信息。');
  }

  const sys = cfg.systems || {};
  const providers = [];

  // 1) MES（U9 智能工厂）—— HTTP 内部实体网关，凭据在 config 里
  if (sys.mes && sys.mes.enabled !== false && sys.mes.base) {
    const p = createU9Provider(sys.mes);
    if (p) providers.push(p);
  }

  // 2) 任意个只读 MySQL 数据源（中央库 / 工位库 / PLM 库 / OA 库，同一套 provider）
  for (const p of createMysqlProviders(sys.mysql || [])) providers.push(p);

  // 3) 已经跑着的业务服务（dcs_server 5001 / 追溯查询 5002）—— 走 HTTP，不在 MCP 里放库口令
  const http = sys.dcs_http;
  if (http && http.enabled !== false && (http.server_url || http.trace_url)) {
    const p = createDcsHttpProvider(http);
    if (p) providers.push(p);
  }

  if (process.env.MCP_DEMO === '1' || !providers.length) providers.push(createDemoProvider());
  return providers;
}
