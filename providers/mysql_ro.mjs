/**
 * provider: 只读 MySQL（一个 config 条目 = 一个数据源 = 一套工具）
 * ---------------------------------------------------------------------------
 * 这是「连接池」那一半：进程常驻、pool 常驻、连接复用；每次查询再叠三层只读保险：
 *   ① 语句必须是 SELECT / WITH 单条，且剥掉字符串/注释后不含写关键字
 *   ② 出现过的表名必须在 information_schema 里存在、且不在 denyTables 里
 *   ③ 连接上开 START TRANSACTION READ ONLY（写了直接报 1792）+ MAX_EXECUTION_TIME 超时
 * 另外所有返回都做行数上限与单元格截断，避免一次查询把 Agent 上下文撑爆。
 */
import mysql from 'mysql2/promise';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const CELL_MAX = 2000;

const READ_HEAD = /^\s*(select|with)\b/i;
const FORBIDDEN = [
  'insert', 'update', 'delete', 'drop', 'truncate', 'alter', 'create', 'replace', 'rename',
  'grant', 'revoke', 'load data', 'into outfile', 'into dumpfile', 'lock tables', 'set global',
  'flush', 'call', 'handler', 'prepare',
];

/** 去掉字符串字面量/标识符引号/注释，只留下"结构"，用于关键字与表名扫描 */
function stripLiterals(sql) {
  let out = '', i = 0, q = null;
  const s = String(sql);
  while (i < s.length) {
    const c = s[i];
    if (q) {
      if (c === '\\') { i += 2; continue; }
      if (c === q) { if (s[i + 1] === q) { i += 2; continue; } q = null; i++; continue; }
      i++; continue;
    }
    if (c === "'" || c === '"' || c === '`') { q = c; i++; continue; }
    if (c === '-' && s[i + 1] === '-') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

function guardSql(sql) {
  const raw = String(sql || '').trim();
  if (!raw) throw new Error('sql 不能为空');
  const bare = stripLiterals(raw);
  if (!READ_HEAD.test(bare)) throw new Error('只读服务：语句必须以 SELECT 或 WITH 开头');
  if (/;/.test(bare.replace(/;\s*$/, ''))) throw new Error('只允许单条语句（不要用 ; 串联多条 SQL）');
  for (const bad of FORBIDDEN) {
    if (new RegExp(`\\b${bad.replace(' ', '\\s+')}\\b`, 'i').test(bare)) {
      throw new Error(`语句里出现禁止的关键字 "${bad}" —— 本服务只读，只能查询`);
    }
  }
  return raw;
}

/** 从 SQL 里抠出被引用的表名（FROM / JOIN 后面那个标识符） */
function referencedTables(sql) {
  const bare = stripLiterals(sql);
  const names = new Set();
  const re = /\b(?:from|join)\s+`?([A-Za-z0-9_$\u4e00-\u9fa5]+)`?/gi;
  let m;
  while ((m = re.exec(bare))) names.add(m[1]);
  return [...names];
}

const clip = (v) => {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string' && v.length > CELL_MAX) return v.slice(0, CELL_MAX) + `…(截断,原长${v.length})`;
  if (Buffer.isBuffer(v)) return `<binary ${v.length}B>`;
  if (typeof v === 'bigint') return v.toString();
  return v;
};
const clipRow = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clip(v)]));

function limitOf(n, def = DEFAULT_LIMIT) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.min(Math.floor(v), MAX_LIMIT);
}

export function createMysqlProviders(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((c) => c && c.host && c.enabled !== false).map(createOne);
}

function createOne(cfg) {
  const id = String(cfg.id || cfg.database || 'db').replace(/[^A-Za-z0-9_]/g, '_');
  const p = `db_${id}`;
  const label = cfg.label || `${cfg.host}:${cfg.port || 3306}/${cfg.database}`;
  const deny = new Set((cfg.denyTables || []).map((t) => String(t).toLowerCase()));
  const limitMax = Math.min(Number(cfg.maxRows) || MAX_LIMIT, MAX_LIMIT);
  const maxExecMs = Number(cfg.maxExecutionTimeMs) || 15000;

  const pool = mysql.createPool({
    host: cfg.host,
    port: Number(cfg.port) || 3306,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    charset: cfg.charset || 'utf8mb4',
    waitForConnections: true,
    connectionLimit: Number(cfg.connectionLimit) || 4,   // ← 连接池大小
    maxIdle: Number(cfg.maxIdle) || 4,
    idleTimeout: Number(cfg.idleTimeoutMs) || 60000,
    queueLimit: 0,
    connectTimeout: Number(cfg.connectTimeoutMs) || 10000,
    enableKeepAlive: true,
    dateStrings: true,             // 时间原样返回字符串，避免驱动做时区换算再"看不出来"
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,     // 驱动层就禁掉多语句
  });

  const tuned = new WeakSet();
  const tune = async (conn) => {
    if (tuned.has(conn)) return;
    tuned.add(conn);
    for (const sql of [`SET SESSION MAX_EXECUTION_TIME=${maxExecMs}`, 'SET SESSION TRANSACTION READ ONLY']) {
      try { await conn.query(sql); } catch (e) { process.stderr.write(`[factory-bridge] ${id} ${sql} 失败(忽略): ${e.message}\n`); }
    }
  };

  async function withConn(fn) {
    let conn;
    try {
      conn = await pool.getConnection();
    } catch (e) {
      const m = String(e?.message || e);
      throw new Error(`连不上 MySQL ${label}：${m}（确认网络可达 / 账号密码 / 该库是否允许远程连接）`);
    }
    try {
      await tune(conn);
      return await fn(conn);
    } finally {
      conn.release();      // 归还到池子，不是关连接
    }
  }

  async function select(sql, limit) {
    const clean = guardSql(sql);
    const cap = limitOf(limit);
    const bare = stripLiterals(clean);
    const wrapped = /^\s*select\b/i.test(bare) ? `SELECT * FROM (${clean.replace(/;\s*$/, '')}) AS _agent_q LIMIT ${cap}` : clean;
    const t0 = Date.now();
    return withConn(async (conn) => {
      // 显式只读事务：即使代码判断被绕过，写操作也会被 MySQL 拒绝（错误 1792）
      try { await conn.query('START TRANSACTION READ ONLY'); } catch { /* 极老版本忽略 */ }
      try {
        const [rows, fields] = await conn.query(wrapped);
        const arr = Array.isArray(rows) ? rows : [];
        return {
          rows: arr.slice(0, cap).map(clipRow),
          rowCount: arr.length,
          truncated: arr.length >= cap,
          columns: (fields || []).map((f) => f.name),
          elapsed_ms: Date.now() - t0,
        };
      } finally {
        try { await conn.query('ROLLBACK'); } catch { /* ignore */ }
      }
    });
  }

  /** 表名必须真实存在且不在禁用名单里 */
  async function assertTables(sql) {
    const names = referencedTables(sql);
    if (!names.length) return names;
    const known = await withConn(async (conn) => {
      const [rows] = await conn.query(
        'SELECT TABLE_NAME n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
      return new Set(rows.map((r) => String(r.n).toLowerCase()));
    });
    for (const n of names) {
      const low = n.toLowerCase();
      if (deny.has(low)) throw new Error(`表 ${n} 在 ${id} 的 denyTables 里，不允许通过本工具查询`);
      if (!known.has(low)) throw new Error(`表 ${n} 在库 ${cfg.database} 里不存在（现有表请用 ${p}_tables 查）`);
    }
    return names;
  }

  const tools = [
    {
      name: `${p}_tables`,
      description: `${label}：列出库里的表（表名、行数、注释），可用 keyword 过滤。查数据前先用它和 ${p}_columns 确认表名字段名。`,
      inputSchema: { type: 'object', properties: { keyword: { type: 'string' }, limit: { type: 'number' } } },
      run: async ({ keyword, limit }) => {
        const rows = await withConn(async (conn) => {
          const [r] = await conn.query(
            `SELECT TABLE_NAME AS name, TABLE_ROWS AS approx_rows, TABLE_COMMENT AS comment, ENGINE AS engine
               FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`);
          return r;
        });
        const kw = String(keyword || '').toLowerCase();
        const hit = kw ? rows.filter((r) => `${r.name} ${r.comment}`.toLowerCase().includes(kw)) : rows;
        return {
          database: cfg.database, total: rows.length, matched: hit.length,
          denied: [...deny],
          tables: hit.slice(0, limitOf(limit || 500)).map((r) => ({ table: r.name, approx_rows: r.approx_rows == null ? null : Number(r.approx_rows), comment: r.comment || '' })),
          note: 'approx_rows 是 InnoDB 估算值，精确行数用 SELECT COUNT(*) 或 db_*_query。',
        };
      },
    },
    {
      name: `${p}_columns`,
      description: `${label}：看某张表的字段（名字/类型/是否可空/主键/注释）。写 SQL 前先看这个，不要猜字段名。`,
      inputSchema: { type: 'object', required: ['table'], properties: { table: { type: 'string' } } },
      run: async ({ table }) => {
        if (!table) throw new Error('必须给 table');
        const t = String(table).trim();
        if (deny.has(t.toLowerCase())) throw new Error(`表 ${t} 在 denyTables 里`);
        const cols = await withConn(async (conn) => {
          const [r] = await conn.query(
            `SELECT COLUMN_NAME n, COLUMN_TYPE t, IS_NULLABLE nullable, COLUMN_KEY colkey, COLUMN_COMMENT comment
               FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [t]);
          return r;
        });
        if (!cols.length) throw new Error(`库 ${cfg.database} 里没有表 ${t}`);
        return { database: cfg.database, table: t, fields: cols.map((c) => ({ field: c.n, type: c.t, nullable: c.nullable === 'YES', key: c.colkey || undefined, comment: c.comment || undefined })) };
      },
    },
    {
      name: `${p}_query`,
      description: `${label}：执行只读 SELECT（单条、强制行数上限、会话级超时）。例：SELECT productSN, COUNT(*) c FROM fact_production WHERE create_time >= '2026-09-01 00:00:00' GROUP BY productSN LIMIT 20。写操作会被拒绝。`,
      inputSchema: {
        type: 'object', required: ['sql'],
        properties: {
          sql: { type: 'string', description: '必须是 SELECT / WITH 开头的单条语句' },
          limit: { type: 'number', description: `返回行数上限，默认 ${DEFAULT_LIMIT}，最大 ${limitMax}` },
        },
      },
      run: async ({ sql, limit }) => {
        await assertTables(sql);
        const out = await select(sql, limit);
        out.database = cfg.database;
        return out;
      },
    },
    {
      name: `${p}_sample`,
      description: `${label}：看某张表的前 N 行样本（了解字段实际长相，比看 DDL 直观）。`,
      inputSchema: {
        type: 'object', required: ['table'],
        properties: { table: { type: 'string' }, limit: { type: 'number' }, order_by: { type: 'string' } },
      },
      run: async ({ table, limit, order_by }) => {
        const t = String(table || '').trim();
        if (!t) throw new Error('必须给 table');
        const ob = order_by ? ` ORDER BY \`${String(order_by).replace(/[^A-Za-z0-9_]/g, '')}\`` : '';
        const out = await select(`SELECT * FROM \`${t.replace(/[^A-Za-z0-9_$\u4e00-\u9fa5]/g, '')}\`${ob}`, limit);
        return { ...out, database: cfg.database, table: t };
      },
    },
    {
      name: `${p}_pool`,
      description: `${label}：连接池与连通性自检（池大小、空闲连接、排队请求数）。查询报错时先跑这个。`,
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const stat = () => ({
          system: id, label, host: cfg.host, port: Number(cfg.port) || 3306, database: cfg.database,
          user: cfg.user, connectionLimit: Number(cfg.connectionLimit) || 4, maxExecutionTimeMs: maxExecMs,
          pool: { total: pool.pool?._allConnections?.length ?? null, free: pool.pool?._freeConnections?.length ?? null, queued: pool.pool?._connectionQueue?.length ?? null },
        });
        try {
          const one = await select('SELECT NOW() AS server_now, DATABASE() AS current_db, VERSION() AS version', 1);
          return { ok: true, ...stat(), server: one.rows[0] };
        } catch (e) {
          return { ok: false, ...stat(), error: String(e?.message || e) };
        }
      },
    },
  ];

  return {
    id,
    label,
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    async call(name, args) {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`${id} 不认识工具 ${name}`);
      return t.run(args || {});
    },
  };
}
