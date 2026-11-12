/**
 * provider: U9 智能工厂 MES（只读）
 * ---------------------------------------------------------------------------
 * 复用 ../lib/u9_client.mjs（AES 登录 + Context 头 + 通用实体网关）。
 * 连接管理由这个 provider 负责：
 *   - 懒登录：进程启动时不连 MES，第一次工具调用才登录
 *   - 单飞(single-flight)：并发调用只触发一次登录
 *   - 令牌失效自动重登：一次失败重试
 *   - 每次查询强制 pageSize 上限，禁止全表拉取
 * 故意不注册任何写端点（save/delete/updateByValue）。
 */
import { readFile } from 'node:fs/promises';
import { U9Client } from '../lib/u9_client.mjs';

/** 本地已导出的实体字典（mes_bridge 里那份），作为 MCP resource 直接给 Agent 读，省一次工具调用 */
const DICT_RESOURCE = 'mes://entity-dictionary';
const DICT_LOCAL = new URL('../../mes_bridge/实体字典.csv', import.meta.url);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const asObj = (v, what) => {
  if (v === undefined || v === null || v === '') return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { throw new Error(`${what} 必须是 JSON 对象或 JSON 字符串，收到: ${String(v).slice(0, 80)}`); }
};

/** 'CreatedOn:-1' 或 { CreatedOn: -1 } → { CreatedOn: -1 } */
const asOrder = (v) => {
  if (!v) return { CreatedOn: -1 };
  if (typeof v === 'object') return v;
  const [field, dir] = String(v).split(':');
  return { [field.trim()]: Number(dir) === 1 ? 1 : -1 };
};

/** 'YYYY-MM-DD'（按 UTC+8 理解）→ ISO UTC 串；已经是 ISO 则原样返回 */
const asIso = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00+08:00`).toISOString();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d\d:?\d\d$/.test(s)) {
    return new Date(`${s}+08:00`).toISOString();
  }
  return s;
};

const limitOf = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(v), MAX_LIMIT);
};

/** 只保留请求的字段，避免把整个 Mongo 文档灌进 Agent 上下文 */
const project = (rows, fields) => {
  const list = Array.isArray(fields) ? fields : String(fields || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return rows;
  return rows.map((r) => Object.fromEntries(list.filter((f) => f in r).map((f) => [f, r[f]])));
};

export function createU9Provider({ base, userCode, password, orgCode, label } = {}) {
  if (!base || !userCode || !password) return null;
  const client = new U9Client({ base, userCode, password });
  let loginPromise = null;

  /** 网络类错误统一补一句人话，别让 Agent 只看到 "fetch failed" */
  const explain = (e) => {
    const m = String(e?.message || e);
    if (/fetch failed|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|abort|socket|network/i.test(m)) {
      return `连不上 MES（${base}）：${m}。本机可能不在公司内网 —— MES 是内网地址，请在能访问它的机器（数采/边缘服务器）上跑这个 MCP 服务。`;
    }
    return m;
  };
  const wrap = (e) => new Error(explain(e));

  const ensureLogin = async () => {
    if (!loginPromise) {
      loginPromise = client.login().catch((e) => { loginPromise = null; throw wrap(e); });
    }
    const state = await loginPromise;
    return { state, fresh: false };
  };

  /** 统一执行：网络/认证类错误补一层可读说明；令牌失效自动重登一次 */
  const run = async (fn) => {
    await ensureLogin();
    try {
      return await fn();
    } catch (e) {
      const m = String(e?.message || e);
      if (/认证失败|4001|401|token/i.test(m)) {
        loginPromise = null;
        await ensureLogin();
        return await fn();
      }
      if (/fetch failed|ECONNREFUSED|ETIMEDOUT|abort|socket|network/i.test(m)) throw wrap(e);
      throw e;
    }
  };

  const paged = async (entity, { where, order, populate, fields, page = 0, pageSize }) => {
    const size = limitOf(pageSize);
    const got = await run(() => client.pageQuery(entity, where, order, populate || '', Number(page) || 0, size));
    const rows = Array.isArray(got) ? got : (got?.Records || []);
    return { entity, page: Number(page) || 0, pageSize: size, returned: rows.length, rows: project(rows, fields) };
  };

  const tools = [
    {
      name: 'mes_entity_list',
      description: '列出 MES 的全部业务实体（370 个左右）及其中文名，可用 keyword 过滤。查数据前先用它确认实体名。',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '按实体名或中文名模糊过滤，如「订单」「Barcode」「QC」' },
          limit: { type: 'number', description: `返回条数上限，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}` },
        },
      },
      run: async ({ keyword, limit }) => {
        const all = await run(() => client.getEntitys());
        const arr = Array.isArray(all) ? all : Object.values(all || {});
        const kw = String(keyword || '').toLowerCase();
        const hit = kw
          ? arr.filter((e) => [e.EntityName, e.Name, e.Description].filter(Boolean).join(' ').toLowerCase().includes(kw))
          : arr;
        return { total: arr.length, matched: hit.length, entities: hit.slice(0, limitOf(limit || 100)).map((e) => ({ entity: e.EntityName, name: e.Name })) };
      },
    },
    {
      name: 'mes_entity_fields',
      description: '查看某实体的中文字段表：字段名、中文名、类型、关联实体、枚举取值（MES 内码→文案）。字段含义不要靠猜。',
      inputSchema: {
        type: 'object', required: ['entity'],
        properties: { entity: { type: 'string', description: '实体名，如 MO / JobSchedule / BarcodeMaster' } },
      },
      run: async ({ entity }) => {
        if (!entity) throw new Error('必须给 entity');
        const md = await run(() => client.getMetadata(entity));
        const fields = md?.Fields || md?.fields || {};
        return {
          entity, fieldCount: Object.keys(fields).length,
          fields: Object.entries(fields).map(([k, v]) => ({
            field: k, name: v?.Name ?? v?.Description, type: v?.FieldType, ref: v?.ref ?? v?.Ref, enum: v?.Enum || undefined,
          })),
        };
      },
    },
    {
      name: 'mes_query',
      description: 'MES 通用只读实体查询（逃生口）。条件用 Mongo 风格：{"Status":1,"CreatedOn":{"$gte":"2026-09-01T00:00:00.000Z"}}。精确/范围条件可用 $gte/$lte/$in/$ne/$exists；模糊匹配请改用 mes_search 思路或先取小范围。',
      inputSchema: {
        type: 'object', required: ['entity'],
        properties: {
          entity: { type: 'string' },
          where: { type: 'string', description: 'Mongo 条件对象（可传 JSON 字符串）' },
          fields: { type: 'string', description: '只返回这些字段，逗号分隔，强烈建议填' },
          order: { type: 'string', description: '排序，如 "CreatedOn:-1"' },
          populate: { type: 'string', description: '关联展开实体名，空格分隔，如 "ItemMaster Org"' },
          page: { type: 'number', description: '页码，从 0 开始' },
          pageSize: { type: 'number', description: `每页条数，默认 ${DEFAULT_LIMIT}，上限 ${MAX_LIMIT}` },
        },
      },
      run: ({ entity, where, fields, order, populate, page, pageSize }) => {
        if (!entity) throw new Error('必须给 entity');
        return paged(entity, { where: asObj(where, 'where'), order: asOrder(order), populate, fields, page, pageSize });
      },
    },
    {
      name: 'mes_count',
      description: '统计满足条件的记录数。大表（QCRecord 175万+）实时 count 约 1.5s，不要放进高频循环。',
      inputSchema: {
        type: 'object', required: ['entity'],
        properties: { entity: { type: 'string' }, where: { type: 'string', description: 'Mongo 条件' } },
      },
      run: async ({ entity, where }) => ({ entity, where: asObj(where, 'where'), count: await run(() => client.count(entity, asObj(where, 'where'))) }),
    },
    {
      name: 'mes_distinct',
      description: '某字段的去重取值（做下拉选项、看枚举分布、核对状态内码是否与字典一致）。',
      inputSchema: {
        type: 'object', required: ['entity', 'field'],
        properties: {
          entity: { type: 'string' }, field: { type: 'string' },
          where: { type: 'string' }, limit: { type: 'number' },
        },
      },
      run: async ({ entity, field, where, limit }) => {
        const distinct = await run(() => client.distinct(entity, field, asObj(where, 'where')));
        const arr = Array.isArray(distinct) ? distinct : (distinct?.Values || distinct?.values || []);
        return { entity, field, values: arr.slice(0, limitOf(limit || 100)) };
      },
    },
    {
      name: 'mes_production_orders',
      description: '查 MES 生产订单（实体 MO）。单号字段是 Code（如 MO202609100001）。Status 内码：0=已确认 1=上线 2=完工 4=已派工 5=待确认。',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '订单号，支持全等' },
          status: { type: 'number', description: '状态内码' },
          itemCode: { type: 'string', description: '料号' },
          since: { type: 'string', description: '创建时间下限，YYYY-MM-DD（按 UTC+8 理解）' },
          until: { type: 'string', description: '创建时间上限，YYYY-MM-DD' },
          limit: { type: 'number' },
        },
      },
      run: ({ code, status, itemCode, since, until, limit }) => {
        const where = {};
        if (code) where.Code = code;
        if (status !== undefined && status !== null && status !== '') where.Status = Number(status);
        if (itemCode) where.ItemCode = itemCode;
        if (since || until) {
          where.CreatedOn = {};
          if (since) where.CreatedOn.$gte = asIso(since);
          if (until) where.CreatedOn.$lte = asIso(until);
        }
        return paged('MO', {
          where, order: { CreatedOn: -1 }, pageSize: limit || 50,
          fields: 'Code,Status,ItemCode,ItemMaster,Qty,TotalCompleteQty,OnlineQty,AssignedQty,PlanStartDate,ActualStartDateTime,ActualEndDateTime,ProductionLine,Routing,IsHold,IsCancel,CreatedOn,CreatedByName',
        });
      },
    },
    {
      name: 'mes_job_schedules',
      description: '查 MES 任务派工单（实体 JobSchedule，车间执行单元：订单×工序×工位×人员×设备）。Status：0=未下达 1=已下达 2=已上线 3=已完工 4=已派工 7=未派工。',
      inputSchema: {
        type: 'object',
        properties: {
          moCode: { type: 'string', description: '所属生产订单号（字段名 Code）' },
          status: { type: 'number' },
          workLocation: { type: 'string', description: '工位' },
          since: { type: 'string', description: '计划开工下限 YYYY-MM-DD' },
          limit: { type: 'number' },
        },
      },
      run: ({ moCode, status, workLocation, since, limit }) => {
        const where = {};
        if (moCode) where.Code = moCode;
        if (status !== undefined && status !== null && status !== '') where.Status = Number(status);
        if (workLocation) where.WorkLocation = workLocation;
        if (since) where.PlanStartDate = { $gte: asIso(since) };
        return paged('JobSchedule', {
          where, order: { CreatedOn: -1 }, pageSize: limit || 50,
          fields: 'Code,MO,Operation,OpName,WorkLocation,Person,Team,ShiftTime,Asset,Sequence,PlanQty,ActualQty,CompleteQty,QualifyQty,ScrapQty,ReworkQty,Status,DeliveryStatus,PlanStartDate,ActualStartDate,ActualEndDate,DispatchedByName,DispatchedOn',
        });
      },
    },
    {
      name: 'mes_barcode_trace',
      description: '按条码做单件追溯：默认返回该条码的主档信息 + 其装配关系（总成↔零件）。',
      inputSchema: {
        type: 'object', required: ['code'],
        properties: {
          code: { type: 'string', description: '条码/Master 码' },
          limit: { type: 'number', description: '装配关系条数上限，默认 100' },
        },
      },
      run: async ({ code, limit }) => {
        if (!code) throw new Error('必须给 code');
        const masters = await run(() => client.find('BarcodeMaster', { Code: code }, { CreatedOn: -1 }, 'ItemMaster Org', undefined));
        const rows = Array.isArray(masters) ? masters : [];
        if (!rows.length) return { code, found: false, hint: 'BarcodeMaster 里没有这个条码；确认是否带前缀/后缀，或改用 mes_query 查 AssemblyRelation。' };
        const rel = await run(() => client.find('AssemblyRelation', { $or: [{ MasterCode: code }, { PartCode: code }] }, { CreatedOn: -1 }, '', undefined));
        return { code, found: true, master: rows[0], assemblyRelations: (Array.isArray(rel) ? rel : []).slice(0, limitOf(limit || 100)) };
      },
    },
    {
      name: 'mes_status',
      description: 'MES 连接自检：返回目标地址、当前登录账号/组织、令牌是否有效。查数报错时先跑这个。',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        try {
          await ensureLogin();
          const n = await run(() => client.count('MO', {}));
          return { ok: true, base, userCode, org: client.org ? { Code: client.org.Code, Name: client.org.Name } : null, moCount: n };
        } catch (e) {
          return { ok: false, base, userCode, error: String(e?.message || e) };
        }
      },
    },
  ];

  return {
    id: 'u9_mes',
    label: label || 'U9 智能工厂 MES',
    tools: tools.map((t) => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
      // provider.call 是统一入口：这里做参数校验边界的兜底
      run: t.run,
    })),
    resources: [
      {
        uri: DICT_RESOURCE,
        name: 'MES 实体字典（370 个业务实体 + 中文名 + 字段数）',
        description: 'MES 全实体清单。写 mes_query 前先读它挑实体名，再用 mes_entity_fields 看字段，别猜。',
        mimeType: 'text/csv',
      },
    ],
    async call(name, args) {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`u9_mes 不认识工具 ${name}`);
      return t.run(args || {});
    },
    async readResource(uri) {
      if (uri !== DICT_RESOURCE) throw new Error(`u9_mes 不提供资源 ${uri}`);
      try {
        return { text: await readFile(DICT_LOCAL, 'utf8'), mimeType: 'text/csv' };   // 本机已有导出，直接用
      } catch { /* 本地没有就现拉一份 */ }
      const all = await run(() => client.getEntitys());
      const arr = Array.isArray(all) ? all : Object.values(all || {});
      const lines = ['EntityName,Name,FieldCount'];
      for (const e of arr) {
        lines.push([e.EntityName, String(e.Name ?? '').replace(/,/g, '，'), Object.keys(e.Fields || {}).length].join(','));
      }
      return { text: '\uFEFF' + lines.join('\n'), mimeType: 'text/csv' };
    },
  };
}
