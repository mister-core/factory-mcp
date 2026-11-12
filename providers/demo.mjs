/**
 * provider: demo —— 协议自检专用（MCP_DEMO=1 时才加载）。
 * 不连任何外部系统，只用来验证 MCP 协议链路（initialize / tools/list / tools/call）。
 */
export function createDemoProvider() {
  const tools = [
    {
      name: 'demo_echo',
      description: '回显收到的参数（协议自检用，不连任何外部系统）。',
      inputSchema: { type: 'object', properties: { text: { type: 'string' }, n: { type: 'number' } } },
      run: async ({ text, n }) => ({ ok: true, echo: { text: text ?? null, n: n ?? null }, at: new Date().toISOString() }),
    },
    {
      name: 'demo_rows',
      description: '生成 N 行假数据（协议自检用，验证返回体大小/截断逻辑）。',
      inputSchema: { type: 'object', properties: { rows: { type: 'number' } } },
      run: async ({ rows }) => ({
        note: '这是 protocol self-test 的假数据，不是业务数据。',
        rows: Array.from({ length: Math.min(Number(rows) || 3, 500) }, (_, i) => ({ i: i + 1, code: `DEMO-${String(i + 1).padStart(4, '0')}` })),
      }),
    },
  ];
  return {
    id: 'demo',
    label: '协议自检（无外部依赖）',
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    async call(name, args) {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`demo 不认识工具 ${name}`);
      return t.run(args || {});
    },
  };
}
