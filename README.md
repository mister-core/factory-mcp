# factory-mcp

**One read-only MCP server for every system on the shop floor.**

In a real plant the data an agent needs is scattered across four or more systems that were never designed to talk to each other: an MES, a central data warehouse, a PLM, an OA. Each one has a different auth flow, a different query dialect, and its own vocabulary for the same physical thing.

`factory-mcp` collapses them into a single long-running process that speaks [MCP](https://modelcontextprotocol.io) over stdio, so an agent can ask *"what ran on line 3 yesterday"* without knowing which system holds the answer — and without ever being able to write to any of them.

```
                     ┌──────────────────────── factory-mcp (one process) ────────────────────────┐
  Agent (MCP client) │  server.mjs   protocol layer: initialize / tools/list / tools/call / resources │
        │            │      │                                                                      │
        └─ stdio ────┼──────┴──┬────────────────────┬────────────────────────┬───────────────────┐
                     │ provider│ u9_mes (HTTP)      │ mysql_ro (one per DB)  │ dcs_http          │
                     │         │ lazy login + retry │ pool + 4-layer RO      │ forward existing  │
                     └─────────┼────────────────────┼────────────────────────┼───────────────────┘
                               ▼                    ▼                        ▼
                        MES over HTTP        warehouse / PLM / OA      already-running services
```

## The hard part is not connectivity — it is choosing the cheapest channel

Every integration I have done started with the same question: *what is the least invasive way to reach this system?* Working from cheap to expensive, always trying the top row first:

| # | Channel | When to use | In this repo | Cost / risk |
|---|---|---|---|---|
| 1 | **Forward an existing service** (HTTP) | Someone already wrapped the DB as a service | ✅ `dcs_http` | Cheapest. The MCP server never holds a DB password; the service keeps its own auth, rate limits and allow-lists |
| 2 | **Official API / SDK** | Swagger, OpenAPI, SOAP, vendor SDK | ⚠️ feasible, needs vendor onboarding | Correct and stable, but the vendor controls your schedule |
| 3 | **Internal web API** (what the frontend calls) | No docs, but there is a web UI | ✅ `u9_mes` | Works today, field names come free in the right language; can break on upgrade |
| 4 | **Read-only DB account** | Most PLM / OA / ERP | ✅ `mysql_ro` | Universal, but you must request the account and own the performance risk |
| 5 | **Views / staging tables / scheduled export** | Vendor won't open an API or the DB | ➖ not implemented | Decoupled and safe, but laggy and needs a sync owner |
| 6 | **File / message / event push** | Interface tables, PLC reports | ➖ not implemented | Near real-time, needs a long-running listener |
| 7 | **UI automation / RPA** | Only the screen is left | ❌ deliberately absent | Brittle, slow, unauditable — last resort only |

The bigger problem is usually **not the network, it is the primary keys**. Two systems that both claim to track a "work order" rarely agree on what identifies one. Before writing a provider I write the term mapping first:

| Business concept | MES | Warehouse | Expected in ERP / PLM / OA |
|---|---|---|---|
| Production order | `MO.Code` | weakly derived from the serial | production order number |
| Unit serial | `BarcodeMaster.Code` | one table for assemblies, one for components | material batch / serial |
| Work center | `JobSchedule.WorkLocation` | `workno` | work center / cost center |
| Employee | `JobSchedule.Person` | absent | OA employee code |
| Equipment | `JobSchedule.Asset` → `AssetRecord` | inside a JSON payload | fixed-asset number |

## Read-only, enforced in four layers

A read-only promise in a README is worth nothing. These layers are in the code, so that a wrong query fails instead of writing:

| Layer | What it does | Where |
|---|---|---|
| Session | `SET SESSION MAX_EXECUTION_TIME` + `SET SESSION TRANSACTION READ ONLY` on every borrowed connection | `providers/mysql_ro.mjs` |
| Transaction | Each query wrapped in `START TRANSACTION READ ONLY … ROLLBACK` — MySQL itself rejects writes with error 1792 even if every check above is bypassed | same |
| Statement allow-list | Must be a single `SELECT` / `WITH`; strings and comments are stripped before scanning for `insert/update/delete/drop/…` | same |
| Table allow-list | Every relation in `FROM` / `JOIN` must exist in `information_schema` and not be listed in `denyTables` | same |
| Result caps | Row limit (default 200, max 2000), 2000-char cell truncation, 180k-char response cap | `server.mjs`, `mysql_ro.mjs` |
| Credentials | Live only in `config.json` (gitignored). On the MES side only read endpoints are wrapped — **not a single write endpoint is registered** | each provider |

## Tool design: 24 tools, not 370

The MES exposes 370+ business entities. Registering one tool per entity would poison the model's context. Tools are layered instead:

1. **Metadata tools** — `*_tables`, `*_columns`, `mes_entity_fields`. The agent looks the schema up instead of guessing field names.
2. **Domain tools** — `mes_production_orders`, `mes_barcode_trace`, `dcs_today_stats`. The business question is baked in, so the model cannot easily misuse it.
3. **Escape hatch** — `db_*_query`, `mes_query`. Covers the questions nobody predicted, bounded by allow-lists, row limits and timeouts.

Plus one MCP **resource** (`mes://entity-dictionary`) so the full entity dictionary can be read on demand without occupying the tool list.

| provider | Source | Tools |
|---|---|---|
| `u9_mes` | MES over HTTP | `mes_entity_list`, `mes_entity_fields`, `mes_query`, `mes_count`, `mes_distinct`, `mes_production_orders`, `mes_job_schedules`, `mes_barcode_trace`, `mes_status` |
| `mysql_ro` | any read-only MySQL (one pool per config entry) | `db_<id>_tables`, `_columns`, `_query`, `_sample`, `_pool` |
| `dcs_http` | existing HTTP services | `dcs_health`, `dcs_index_tables`, `dcs_table_columns`, `dcs_query`, `dcs_today_stats`, `dcs_batch_query`, `dcs_dashboard`, `dcs_trace` |
| `demo` | none (protocol self-check) | `demo_echo`, `demo_rows` |

## Quick start

```bash
npm install                       # only dependency: mysql2
cp config.example.json config.json  # fill in endpoints + credentials

node server.mjs                   # stdio mode, for an MCP client
node selftest.mjs                 # end-to-end self-test (spawns a real child process)
```

The self-test covers handshake, tool discovery, argument passing, unknown tools, connection pooling, a real `SELECT`, **a rejected write statement**, **a rejected non-existent table**, the row cap, an unreachable data source (readable error, process survives), and resource reads. **14/15 passing on a machine with no plant network access** — the single failing check is `resources/read`, which fetches the live 370-entity dictionary over HTTP and therefore needs a reachable MES. Everything that can be verified offline passes.

It expects a throwaway MySQL on `127.0.0.1:3308` (see `config.selftest.json`); `tools/seed_selftest.sql` creates the schema and sample rows.

## Adapting to another U9 deployment

`u9_client.mjs` implements the sign-in chain: the password is concatenated with a millisecond timestamp and sent AES-128-CBC (zero padding, Base64) using a key/IV that the vendor ships as constants inside the frontend bundle. Those constants are **not** in this repo — set them yourself:

```bash
export U9_AUTH_KEY=...   # 16 bytes, from your own deployment's frontend JS
export U9_AUTH_IV=...    # 16 bytes, same place
```

How to find them: open the MES web UI, grep the loaded JS bundles for `createCipheriv` / the sign-in endpoint, and read the two 16-character string literals near it. They differ per deployment.

## Adding a provider (PLM, OA, anything)

1. Add a file under `providers/` exporting `createXxxProvider(cfg)` → `{ id, label, tools, resources?, call(name, args), readResource? }`
2. Copy `providers/mysql_ro.mjs` and swap the driver for SQL Server / Oracle / PostgreSQL (`mssql` / `oracledb` / `pg`) — the structure stays the same
3. Register it in `providers/index.mjs`, gated by config
4. Add a section to `config.example.json`
5. Add a real query against it in `selftest.mjs` — **a provider with no test data is not done**

`server.mjs`, the protocol layer, tool aggregation and truncation logic all stay untouched.

## Verified / not verified

**Verified**
- MCP protocol path (handshake / discovery / call / resource / error) — 14/15, see below
- Read-only MySQL pool against a real MySQL 5.7.44: connection pooling, a real `SELECT` returning 4 rows in 5 ms, write statement rejected by the statement allow-list, non-existent table rejected by the table allow-list, row cap (`rowCount=2, truncated=true`)
- Unreachable data source: readable error, process keeps running and can be pinged again

**Not verified here**
- `resources/read` — it fetches the entity dictionary from a live MES, and no plant network was available. This is the one failing self-test check.
- `mes_*` against a live MES — the HTTP client itself was verified in a separate project; this repo only wraps it
- `dcs_*` against live services — tool registration is verified, the request shapes follow the service source
- PLM / OA — those systems have not been identified yet, so nothing exists

Kept honest on purpose: an integration that claims to work without ever touching the target system is worth nothing in an interview or in production.

## License

MIT
