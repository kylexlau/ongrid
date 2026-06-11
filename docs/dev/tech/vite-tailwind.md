# Vite & Tailwind CSS

> 构建器是 Vite 5，样式是 Tailwind 3 原子类。两者决定了「改一行样式怎么生效」
> 和「为什么生产包长那样」。

## Vite

### 1. 两种模式

| 模式 | 命令 | 原理 |
|------|------|------|
| 开发 | `npm run dev` | 不打包：浏览器直接加载 ESM，改文件毫秒级热更新（HMR） |
| 生产 | `npm run build` | `tsc -b`（类型检查）+ Rollup 打包到 `web/dist/` |

开发服务器把 `/api` 代理到本地后端（`vite.config.ts` 的 `server.proxy`），
所以前端开发不需要 nginx。

### 2. 本仓库 vite.config.ts 的三个定制（都有注释）

- `@` 别名 → `web/src`（import 路径 `@/api/...`）；
- **manualChunks**：只把 recharts（vendor-charts）和 xterm（vendor-xterm）
  拆出去——它们大且只有 Monitor/DeviceShell 用。刻意保守：激进拆 chunk 会因
  模块副作用初始化顺序炸出黑屏；
- **modulePreload 过滤**：登录页不预载上面两个大 chunk。

### 3. 懒加载路由

`App.tsx` 用 `lazy(() => import('./pages/Foo'))`——每个页面是独立 chunk，
构建产物里看到 `Knowledge-xxx.js` 就是这么来的。
**生产栈的 SPA 烤在 nginx 镜像里**：改了前端要 `docker compose build nginx`
才能在 https://localhost 看到（开发时用 `npm run dev` 即时看）。

## Tailwind

### 1. 原子类心智模型

不写 CSS 文件，HTML 里组合工具类；类名即样式，review 时所见即所得：

```tsx
<div className="flex items-center gap-2 rounded-md border border-zinc-800/60
                bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-900" />
```

常用词表：布局 `flex/grid/gap-*/items-*/justify-*`；盒子
`p-*/m-*/w-*/max-w-*/rounded-*/border`；文本 `text-{size}/{color}/font-*/truncate`；
状态前缀 `hover:/focus:/disabled:`；响应式前缀 `md:/lg:`。

构建时扫描源码**字符串字面量**生成用到的类——所以**不能动态拼类名**
（`bg-${color}-500` 扫不到，会丢样式）。

### 2. 本仓库的配色纪律（AGENTS.md 前端红线）

| 用途 | 类 |
|------|----|
| 容器骨架 | `bg-zinc-900/40` + `border-zinc-800/60`，文字 `zinc-100/400/500` |
| 主操作 | `indigo-600` 按钮 |
| 语义状态 | 仅 emerald(成功)/amber(降级)/red(异常)/sky(信息)，走 Chip `tone`，状态点 `-500` 档 |
| 品牌紫 `--accent` | 只给 logo/品牌面 |

### 3. light/dark 主题的实现与坑

暗色是默认设计；亮色靠 `web/src/styles/index.css` 里 `html.light` 对 zinc 类
的**覆盖**（不是 Tailwind `dark:` 双写）。坑：带透明度的 `bg-zinc-900/20`
不会被 `.bg-zinc-900` 选择器命中——优先用纯 zinc 类；必须用透明度变体时在
index.css 补 `html.light .bg-zinc-900\/NN`。主题切换逻辑在 `store/mode.ts`
（`html` 上切 `light/dark` class）。

## 实用指引

```bash
cd web
npm run dev                    # 开发
npm run build                  # 产物到 dist/（PR 前必跑）
npx vite build --mode development --minify false   # 排查打包问题时可读产物
```

- 改样式找不到生效位置：浏览器 DevTools 直接看元素 class，全局搜该 class 串；
- 新增大依赖前想想 chunk 归属——只被单页用的大库考虑 lazy import；
- markdown 正文样式是例外（`.md-body` 系列，在 index.css 手写 CSS），
  因为 ReactMarkdown 产出的标签没法挂原子类。

## 学习资料

- [Vite 官方指南](https://vitejs.dev/guide/)
- [Tailwind 文档](https://tailwindcss.com/docs)（当字典查，别通读）
