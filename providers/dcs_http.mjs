/**
 * provider: 已跑着的业务服务（HTTP）—— dcs_server:5001 + 追溯查询:5002
 * ---------------------------------------------------------------------------
 * 为什么要有这一层：这两台服务已经在做「只读 + 表白名单 + 参数化 + 保护表」的事，
 * 而且它们连着中央库。MCP 这边就不要再塞一份数据库口令，直接把它们的能力转成工具。
 * 好处：口子只有一个（服务自身的鉴权/限流/保护表继续生效），坏处：多一跳 HTTP。
 */
const NEED = { server_url: '', trace_url: '' };

async function httpJson(url, { method = 'GET', body, timeoutMs = 30000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ac.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!json) throw new Error(`${url} 返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 200)}`);
    if (json.status === 'error') throw new Error(`${url} -> ${json.error}`);
    return json;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`请求超时(${timeoutMs}ms): ${url}`);
    throw e;
  } finally { clearTimeout(timer); }
}

const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : v)}`).join('&');

export function createDcsHttpProvider(cfg = {}) {
  const serverUrl = (cfg.server_url || NEED.server_url).replace(/\/$/, '');
  const traceUrl = (cfg.trace_url || NEED.trace_url).replace(/\/$/, '');
  const timeoutMs = Number(cfg.timeout_ms) || 30000;
  if (!serverUrl && !traceUrl) return null;

  const S = (p, opt) => httpJson(serverUrl + p, { ...opt, timeoutMs });
  const T = (p, opt) => httpJson(traceUrl + p, { ...opt, timeoutMs });

  const tools = [
    {
      name: 'dcs_health',
      description: '数采服务健康检查：dcs_server(5001) 与追溯查询(5002) 是否在线、连的哪个库。',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const out = { dcs_server: null, trace_query: null };
        try { out.dcs_server = serverUrl ? await S('/health') : '未配置'; } catch (e) { out.dcs_server = { ok: false, error: String(e.message) }; }
        try { out.trace_query = traceUrl ? await T('/health') : '未配置'; } catch (e) { out.trace_query = { ok: false, error: String(e.message) }; }
        return out;
      },
    },
    {
      name: 'dcs_index_tables',
      description: '数采中央库里的「产品型号表」清单（表名 + 精确行数 + 是否镜像表 + 列）。做追溯/统计前先看有哪些型号表。',
      inputSchema: { type: 'object', properties: {} },
      run: async () => S('/api/index/tables'),
    },
    {
      name: 'dcs_table_columns',
      description: '某张型号表的字段（名字/类型），可带 values=列名 顺带返回该列已有值（给筛选用）。',
      inputSchema: { type: 'object', required: ['table'], properties: { table: { type: 'string' }, values: { type: 'string' } } },
      run: async ({ table, values }) => S(`/api/index/table/${encodeURIComponent(table)}/columns${values ? '?' + qs({ values }) : ''}`),
    },
    {
      name: 'dcs_query',
      description: '按型号表做条件查询（只读、表/列白名单、值参数化）。filters 例：[{"column":"testmysql_CY_1","op":"prefix","value":"1001640"}]。op 取值：eq ne gt ge lt le like prefix suffix between in isnull notnull（between 需 value+value2，in 用逗号分隔）。',
      inputSchema: {
        type: 'object', required: ['table'],
        properties: {
          table: { type: 'string', description: '型号表名，如 1640zz' },
          filters: { type: 'array', description: '条件数组', items: { type: 'object' } },
          match: { type: 'string', description: 'and / or' },
          order_by: { type: 'string' }, desc: { type: 'boolean' },
          limit: { type: 'number' }, offset: { type: 'number' },
          columns: { type: 'array', items: { type: 'string' }, description: '只返回这些列' },
        },
      },
      run: async (args) => S('/api/index/query', { method: 'POST', body: args }),
    },
    {
      name: 'dcs_today_stats',
      description: '今日（或指定日期）产量统计：生产/合格/不合格/最近生产时间。',
      inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD，默认今天' } } },
      run: async ({ date }) => S(`/api/stats/today${date ? '?' + qs({ date }) : ''}`),
    },
    {
      name: 'dcs_batch_query',
      description: '生产记录批量查询（时间范围/工位/结果/SN）——直接打生产事实表，是产量与明细核对的主力工具。',
      inputSchema: {
        type: 'object',
        properties: {
          startTime: { type: 'string' }, endTime: { type: 'string' },
          workno: { type: 'string', description: '工位编号' },
          result: { type: 'string', description: 'OK / NO' },
          productSN: { type: 'string' }, snLike: { type: 'string', description: 'SN 模糊' },
          limit: { type: 'number' }, offset: { type: 'number' },
        },
      },
      run: async (args) => S('/api/query/batch', { method: 'POST', body: args }),
    },
    {
      name: 'dcs_dashboard',
      description: '生产看板数据（工位在线/离线/近期产量，口径 create_time）。',
      inputSchema: { type: 'object', properties: {} },
      run: async () => T('/api/dashboard'),
    },
    {
      name: 'dcs_trace',
      description: '★按码追溯：给一个总成码/零件码/条码 → 各索引表里的绑定记录 + 该码在生产表里的完整生产数据（data JSON 已解析）。跨表追溯就用它，不要自己拼 SQL。',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '单个码' },
          codes: { type: 'array', items: { type: 'string' }, description: '多个码' },
          like: { type: 'boolean', description: '前缀匹配' },
          limit: { type: 'number' },
        },
      },
      run: async (args) => T('/api/trace', { method: 'POST', body: args }),
    },
  ];

  return {
    id: 'dcs',
    label: `数采服务（${serverUrl || '-'} / ${traceUrl || '-'}）`,
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    async call(name, args) {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`dcs 不认识工具 ${name}`);
      return t.run(args || {});
    },
  };
}
