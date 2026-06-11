# Vitest & Testing Library & MSW

> 前端测试三件套：Vitest（跑测试，Vite 原生）、Testing Library（按用户视角
> 查询/操作 DOM）、MSW（拦截 fetch 假扮后端）。环境是 jsdom（Node 里的假浏览器）。

## Vitest

Jest 兼容 API，但直接复用 Vite 的配置（别名、TS 都开箱即用）：

```bash
cd web
npm run test                              # 全量（CI 同款，vitest run）
npx vitest run src/pages/Knowledge.test.tsx   # 单文件
npx vitest src/pages/Knowledge.test.tsx       # watch 模式开发
npx vitest run -t '复制为组织文档'              # 按用例名过滤
```

结构与断言：

```ts
describe('KnowledgePage', () => {
  beforeEach(() => { ... });
  it('点击内置文档打开只读查看器', async () => {
    expect(x).toBe(1);
    expect(obj).toMatchObject({ title: '...' });   // 部分匹配，最常用
  });
});
vi.mock('@/store/auth', () => ({ ... }));          // 模块级 mock（顶层声明，自动提升）
```

## Testing Library

哲学：**像用户一样找元素**（按角色/文案），而不是按 class/测试 id——
测试因此对重构稳健：

```tsx
render(<KnowledgePage />);
await screen.findByText('组织 SOP');                       // find* = 等异步出现
screen.getByRole('button', { name: '保存' });              // get* = 必须已存在
expect(screen.queryByRole('table')).not.toBeInTheDocument(); // query* = 断言不存在
await userEvent.click(card);                               // 真实事件序列
await userEvent.type(input, '更新后的正文');
await waitFor(() => expect(spy).toHaveBeenCalled());       // 等任意异步断言
```

三族查询的选择：**等出现用 findBy，断言存在用 getBy，断言不存在用 queryBy**。
多个同名元素报错时收窄 name（正则 `^` 锚定，见 Knowledge.test.tsx 注释）。

## MSW（Mock Service Worker）

在网络层拦截请求——被测代码跑的是**真实的** fetch/client.ts 逻辑：

```ts
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw-server';

server.use(
  http.get('/api/v1/knowledge/docs', () =>
    HttpResponse.json({ items: [vaultDoc], total: 1 })),
  http.post('/api/v1/knowledge/docs', async ({ request }) => {
    createdBody = await request.json();          // 捕获请求体做断言
    return HttpResponse.json({ id: '303' });
  }),
);
```

本仓库约定（`web/src/test/msw-server.ts`）：**server 是空的**，handler 在各
测试文件里 `server.use()` 注册——fixture 跟断言放一起，一眼看清。
`setup.ts` 配了 `onUnhandledRequest: 'error'`：漏写 handler 会大声失败而不是挂死。

## 本仓库的环境坑（已兜底，别踩回去）

`web/src/test/setup.ts` 里有一段 localStorage 内存兜底——Node 22+ 的实验性
webstorage 全局会盖掉 jsdom 的 localStorage（getItem 是 undefined），任何走
`useI18n()` 的组件 render 即炸。**不要删那段代码**。
另外测试里固定 locale：`localStorage.setItem('ongrid-locale', 'zh-CN')`，
断言文案才不受机器时区影响。

## 在本仓库

| 想看什么 | 打开 |
|----------|------|
| 页面测试范本（弹窗/表单/请求体断言） | `web/src/pages/Knowledge.test.tsx` |
| store mock + 角色切换 | `web/src/pages/settings/Marketplace.test.tsx` |
| 测试环境装配 | `web/src/test/setup.ts`、`msw-server.ts`、`vitest.config.ts` |

## 写新测试的检查单

1. fixture 数据贴近真实响应形状（id 是 string！见 api/knowledge.ts 注释）；
2. mock `@/store/auth`（client.ts 需要 getToken / useAuth.getState）；
3. 异步 UI 一律 `await findBy*` / `waitFor`，不要 setTimeout；
4. 断言「发给后端什么」比断言「页面长什么样」更值钱（捕获 request.json()）；
5. 跑 `npm run test` 确认没把别的文件搞挂（onUnhandledRequest=error 会放大影响）。

## 学习资料

- [Vitest 文档](https://vitest.dev/guide/)
- [Testing Library 查询优先级](https://testing-library.com/docs/queries/about/#priority)
- [MSW 文档](https://mswjs.io/docs/)
