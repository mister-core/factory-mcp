# factory-mcp ｜ 工厂系统只读 MCP 网关

把车间里互相不通的几套系统（MES / PLM / OA / 中央数采库 / 已跑着的业务服务）**收敛成一个常驻进程**：
内部按数据源分 provider、每个数据源一套连接池，对外通过 MCP 暴露成工具，Agent 直接调用。

```
                       ┌──────────────────────── factory-mcp（一个常驻进程）────────────────────────┐
  Agent (MCP client)   │  server.mjs   MCP 协议层：initialize / tools/list / tools/call / resources  │
      │  stdio JSON-RPC│      │                                                                      │
      └────────────────┼──────┴──┬───────────────────┬────────────────────┬───────────────────┐     │
                       │  provider│ u9_mes            │ mysql_ro（每个库）  │ dcs_http          │     │
                       │  （HTTP）│ 懒登录+单飞+重登   │ 连接池+只读四层防线 │ 转发已有服务       │     │
                       └──────────┼───────────────────┼────────────────────┼───────────────────┘     │
                                  ▼                   ▼                    ▼
                           MES over HTTP        中央库 / PLM / OA      已跑着的 http 服务
```

## 一、连接方式矩阵：一个系统怎么"打通"

按成本从低到高排，**永远从上往下试**，能读就不要写、有接口就不要碰库：

| # | 通道 | 适用 | 本仓库 | 代价 / 风险 |
|---|---|---|---|---|
| 1 | **已有服务转发**（HTTP） | 已经有人把库包成了服务 | ✅ `dcs_http` | 最省：MCP 里不放库口令，服务自带的鉴权/限流/保护表继续生效 |
| 2 | **官方 API / SDK** | 有 swagger、OpenAPI、SOAP、厂商 SDK | ⚠️ 可行，需厂商配合 | 正道、稳定，但节奏不在自己手里 |
| 3 | **内部 Web API**（前端自己调的接口） | 没有文档但有 Web 前端 | ✅ `u9_mes` | 立刻可用、字段自带中文名；升级可能变，要盯 |
| 4 | **数据库只读账号直连** | PLM / OA / ERP 大多如此 | ✅ `mysql_ro` | 最通用；但要申请只读账号 + 自己承担结果集/性能风险 |
| 5 | **中间表 / 视图 / 定时导出** | 厂商不肯开接口、库也不给碰 | ➖ 待做 | 稳（松耦合），但有延迟，要有人维护同步 |
| 6 | **文件 / 报文 / 事件推送** | 接口表、PLC 上报 | ➖ 待做 | 实时性好，需要常驻监听进程 |
| 7 | **UI 自动化 / RPA** | 只剩界面能用 | ❌ 故意不做 | 脆、慢、无法审计；只当最后兜底 |

**真正的难点不是网络打通，是主键对不上。** 两套系统都说自己管"工单"，但标识它的字段往往不一样。
所以先落一张术语映射表再写代码：

| 业务概念 | MES | 中央库 | 期望在 ERP/PLM/OA |
|---|---|---|---|
| 生产工单 | `MO.Code` | 由序列号弱关联 | 工单号 / 生产订单号 |
| 单件条码 | `BarcodeMaster.Code` | 总成表 / 零件表各一张 | 物料批次 / 序列号 |
| 工位 | `JobSchedule.WorkLocation` | `workno` | 工作中心 / 成本中心 |
| 人员 | `JobSchedule.Person` | 无 | OA 工号 |
| 设备 | `JobSchedule.Asset` → `AssetRecord` | JSON 内的设备号 | 固定资产号 |

## 二、只读，靠四层代码兜底

README 上写"只读"没有意义，要写死：

| 层 | 做法 | 位置 |
|---|---|---|
| 会话 | 借出的连接先 `SET SESSION MAX_EXECUTION_TIME` + `SET SESSION TRANSACTION READ ONLY` | `providers/mysql_ro.mjs` |
| 事务 | 每条查询包在 `START TRANSACTION READ ONLY … ROLLBACK` 里 —— 即使上面的判断被绕过，MySQL 也会用 1792 拒绝写操作 | 同上 |
| 语句白名单 | 必须是 `SELECT`/`WITH` 单条；剥掉字符串与注释后再扫 `insert/update/delete/drop/…` | 同上 |
| 表白名单 | SQL 里 `FROM`/`JOIN` 的表必须在 `information_schema` 里存在，且不在 `denyTables` | 同上 |
| 结果上限 | 行数上限（默认 200，最高 2000）、单元格 2000 字符截断、整体 18 万字符截断 | `server.mjs` |
| 凭据 | 只在 `config.json`（已 gitignore）；MES 侧**写接口一个都不注册** | 各 provider |

## 三、工具设计：24 个工具，不是 370 个

MES 有 370+ 业务实体，一个实体一个工具会把模型的上下文塞满。分三层：

1. **元数据工具**（`*_tables`、`*_columns`、`mes_entity_fields`）—— 先查字典，别猜字段名；
2. **领域工具**（`mes_production_orders`、`mes_barcode_trace`、`dcs_today_stats`）—— 把"业务怎么问"固化，模型不容易用错；
3. **通用逃生口**（`db_*_query`、`mes_query`）—— 兜住没预料到的问法，靠白名单 + 上限 + 超时控风险。

外加一个 MCP **resource**（`mes://entity-dictionary`）：实体字典按需读，不占工具列表。

| provider | 数据源 | 工具 |
|---|---|---|
| `u9_mes` | MES over HTTP | `mes_entity_list`、`mes_entity_fields`、`mes_query`、`mes_count`、`mes_distinct`、`mes_production_orders`、`mes_job_schedules`、`mes_barcode_trace`、`mes_status` |
| `mysql_ro` | 任意只读 MySQL（每个配置一条连接池） | `db_<id>_tables`、`_columns`、`_query`、`_sample`、`_pool` |
| `dcs_http` | 已跑着的 HTTP 服务 | `dcs_health`、`dcs_index_tables`、`dcs_table_columns`、`dcs_query`、`dcs_today_stats`、`dcs_batch_query`、`dcs_dashboard`、`dcs_trace` |
| `demo` | 无（协议自检） | `demo_echo`、`demo_rows` |

## 四、跑起来

```bash
npm install                          # 唯一依赖 mysql2
cp config.example.json config.json   # 填 base / 账号 / 库口令
node server.mjs                      # stdio 模式，给 MCP 客户端调用
node selftest.mjs                    # 端到端自检（起真子进程，按协议逐步验）
```

自检覆盖：握手、工具发现、参数传递、未知工具、连接池、真实 SELECT、**写语句被拒**、
**不存在的表被拒**、行数上限、不可达数据源（错误可读、进程不崩）、资源读取。

**本机实测 14/15 通过**（本机不在公司内网）。唯一失败项是 `resources/read`——
它要连真实 MES 拉 370 个实体的字典，离线环境必然失败。其余全部通过。

自检需要一个临时 MySQL（`config.selftest.json` 默认指向 `127.0.0.1:3308`），
`tools/seed_selftest.sql` 会建表并灌 4 行假数据。

## 五、适配另一套 U9 部署

`lib/u9_client.mjs` 实现登录链路：密码拼接毫秒时间戳后 AES-128-CBC（零填充 + Base64），
密钥和 IV 是厂商前端 bundle 里的两个常量。**这两个值不在本仓库**，自己注入：

```bash
export U9_AUTH_KEY=...   # 16 字节
export U9_AUTH_IV=...    # 16 字节
```

找法：打开 MES 前端，在已加载的 JS bundle 里搜登录接口或 `createCipheriv`，附近有两个 16 字符的字符串常量。各家部署不同。

## 六、再加一套系统（PLM / OA）

1. `providers/` 下加一个文件，导出 `createXxxProvider(cfg)` → `{ id, label, tools, resources?, call(name,args), readResource? }`
2. 复制 `providers/mysql_ro.mjs`，把驱动换成 SQL Server / Oracle / PostgreSQL（`mssql` / `oracledb` / `pg`），结构不变
3. `providers/index.mjs` 里按配置挂上
4. `config.example.json` 加一段
5. `selftest.mjs` 里加一条真实查询 —— **没有测试数据的 provider 不算做完**

`server.mjs`、协议层、工具聚合、截断逻辑都不用改。

## 七、验证过的 / 没验证的

**已实测**
- MCP 协议链路（握手 / 工具发现 / 调用 / 资源 / 错误）
- 只读 MySQL 连接池（真 MySQL 5.7.44）：真 `SELECT` 返回 4 行 / 5ms、写语句被白名单拒绝、
  不存在的表被拒绝、行数上限 `rowCount=2 truncated=true`
- 数据源不可达：错误可读、进程不崩、可继续 ping

**未实测**
- `resources/read`（要连真实 MES，本机无内网）
- `mes_*` 的真实取数（HTTP 客户端在另一个项目里验过，这里只是包装）
- `dcs_*` 对真实服务的调用（工具注册已验证，入参按服务源码写）
- PLM / OA（还没确定是哪家的系统）

故意写清楚：声称能用但从没碰过目标系统的集成，在面试和生产里都一文不值。

## License

MIT
