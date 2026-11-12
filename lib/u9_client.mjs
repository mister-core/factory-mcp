// U9 智能工厂（智能工厂2.0 / MEAN 栈）只读数据客户端
// ---------------------------------------------------------------------------
// 认证链路：
//   1) POST /open/auth/signin
//      body: { UserCode, Password: AES128CBC_ZeroPadding(pwd + loginid) -> Base64,
//              captcha: null, id: loginid(毫秒时间戳), LoginTerminalType: 3, isEncrypto: true }
//      返回 Data.User.Token（JWT）与 Data.User.Orgs[]
//   2) 其它所有内部接口：POST + 自定义请求头
//      Context: encodeURI(JSON.stringify({ User:{_id,Code,Name}, Org:{_id,Code,Name,WC}, Token }))
//
// 本模块只实现【读】接口，故意不暴露 /api/entity/save|delete|updateByValue 等写接口，
// 以免脚本被误用成数据修改工具。
// ---------------------------------------------------------------------------
import crypto from 'node:crypto';

// 认证用的 AES-128 key / iv 是用友前端 bundle 里的常量，各家部署不同。
// 部署时从自己环境的前端 JS 里 grep 出来，通过环境变量注入（不要把真实值写进仓库）。
const AseKey = process.env.U9_AUTH_KEY || 'CHANGE_ME_KEY_16';
const IV = process.env.U9_AUTH_IV || 'CHANGE_ME_IV_161';

export function aesEncrypt(text) {
  const data = Buffer.from(text, 'utf8');
  const padLen = (16 - (data.length % 16)) % 16;      // ZeroPadding
  const padded = Buffer.concat([data, Buffer.alloc(padLen, 0)]);
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(AseKey), Buffer.from(IV));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(padded), c.final()]).toString('base64');
}

export class U9Client {
  constructor({ base = 'http://127.0.0.1:4100', userCode, password } = {}) {
    this.base = base.replace(/\/$/, '');
    this.userCode = userCode;
    this.password = password;
    this.token = null; this.user = null; this.org = null;
  }

  contextHeader() {
    const ctx = { User: null, Org: null, Token: this.token };
    if (this.user) ctx.User = { _id: this.user._id, Code: this.user.Code, Name: this.user.Name };
    if (this.org) ctx.Org = { _id: this.org._id, Code: this.org.Code, Name: this.org.Name, WC: this.org.WC };
    return encodeURI(JSON.stringify(ctx));
  }

  async raw(path, body, { method = 'POST', timeoutMs = 120000 } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Context'] = this.contextHeader();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(this.base + path, {
        method, headers, signal: ac.signal,
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* html */ }
      return { status: res.status, json, text };
    } finally { clearTimeout(timer); }
  }

  async login(userCode = this.userCode, password = this.password) {
    const id = String(Date.now());
    const r = await this.raw('/open/auth/signin', {
      UserCode: userCode, Password: aesEncrypt(password + id), captcha: null,
      id, LoginTerminalType: 3, isEncrypto: true,
    });
    if (!r.json || r.json.Error) throw new Error('登录失败: ' + JSON.stringify(r.json?.Error ?? r.text.slice(0, 200)));
    const d = r.json.Data;
    this.token = d.User.Token; this.user = d.User; this.org = (d.User.Orgs || [])[0] || null;
    return d;
  }

  async api(path, body) {
    const r = await this.raw(path, body);
    if (!r.json) throw new Error(`${path} 返回非 JSON: ${r.text.slice(0, 200)}`);
    if (r.json.Error) throw new Error(`${path} -> ${JSON.stringify(r.json.Error)}`);
    return r.json.Data;
  }

  // ---- 只读通用实体接口 ------------------------------------------------
  /** 全部实体字典（EntityName / Name / Fields，含中文字段名、类型、关联、枚举） */
  getEntitys() { return this.api('/api/entity/getEntitys', {}); }
  /** 单实体完整元数据 */
  getMetadata(entityName) { return this.api('/api/entity/getEntityNewMetadata', { EntityName: entityName }); }
  /** 条件查询，返回数组 */
  find(entityName, condition = {}, orderBy = {}, populate = '', project) {
    return this.api('/api/entity/find', { EntityName: entityName, Condition: condition, OrderBy: orderBy, Populate: populate, Project: project });
  }
  /** 原生 Mongo 查询（聚合/复杂条件） */
  findNative(entityName, condition = {}, orderBy = {}, populate = '', project) {
    return this.api('/api/entity/find_native', { EntityName: entityName, Condition: condition, OrderBy: orderBy, Populate: populate, Project: project });
  }
  /** 分页查询，PageNum 从 0 开始 */
  pageQuery(entityName, condition = {}, orderBy = {}, populate = '', pageNum = 0, pageSize = 50) {
    return this.api('/api/entity/pageQuery', { EntityName: entityName, Condition: condition, OrderBy: orderBy, Populate: populate, PageNum: pageNum, PageSize: pageSize });
  }
  /** 记录数 */
  count(entityName, condition = {}) { return this.api('/api/entity/queryRecordCount', { EntityName: entityName, Condition: condition }); }
  /** 字段去重值（做下拉选项/枚举分布） */
  distinct(entityName, field, condition = {}) { return this.api('/api/entity/distinct', { EntityName: entityName, Field: field, Condition: condition }); }
  /** Mongo 聚合管道 */
  aggregate(entityName, args) { return this.api('/api/entity/aggregate', { EntityName: entityName, Arguments: args }); }

  /** 全量分页拉取（按 pageSize 循环，最多 maxPages 页），返回 {rows, pages} */
  async fetchAll(entityName, { condition = {}, orderBy = { _id: 1 }, populate = '', pageSize = 500, maxPages = 10000, onPage } = {}) {
    const rows = [];
    for (let p = 0; p < maxPages; p++) {
      const got = await this.pageQuery(entityName, condition, orderBy, populate, p, pageSize);
      const arr = Array.isArray(got) ? got : (got && got.Records) || [];
      rows.push(...arr);
      if (onPage) onPage(p, arr.length, rows.length);
      if (arr.length < pageSize) return { rows, pages: p + 1 };
    }
    return { rows, pages: maxPages };
  }
}
