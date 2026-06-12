# TypeScript + React 18

> 前端是 React 18 + TypeScript 5 的 SPA。本篇给「会写代码但不熟这俩」的人
> 一个够用的心智模型 + 本仓库惯用法。

## TypeScript：会被本仓库用到的部分

### 1. 类型即文档

```ts
export type KnowledgeDoc = {
  id: string;                // uint64 后端按 string 发，防 2^53 溢出
  source_type: DocSource;    // 联合类型收窄取值范围
  title_en?: string;         // ? = 可选
  tags?: string[];
};
export type DocSource = 'manual' | 'repo' | 'url' | 'vault' | 'upload';
```

- **字面量联合类型**（`'a' | 'b'`）是本仓库的枚举写法，switch 时编译器帮你查漏；
- API 响应类型集中在 `web/src/api/*.ts`，页面 import 类型而不是自己声明；
- `unknown` 优于 `any`：拿到先收窄（`typeof` / `instanceof` / 字段判断）再用。

### 2. 泛型读法

```ts
function request<T = unknown>(method: ..., path: string): Promise<T>
// 调用处: request<{ items: KnowledgeDoc[] }>('GET', '/knowledge/docs')
```

`<T>` 就是「类型参数」：调用方告诉函数「这次返回什么形状」。

## React：心智模型三句话

1. **UI = f(state)**——组件是纯函数，state 变了重新执行整个函数体重算 JSX；
2. **state 不可变更新**——`setItems([...items, x])` 而不是 `items.push(x)`；
3. **副作用进 useEffect**——请求、订阅、DOM 操作不写在渲染路径上。

### 高频 hooks（本仓库出现频率排序）

```tsx
const [editing, setEditing] = useState<Doc | 'create' | null>(null);

useEffect(() => {           // 挂载/依赖变化时执行；返回清理函数
  void fetchAll();
}, [fetchAll]);

const visibleDocs = useMemo( // 依赖不变就不重算（贵的派生数据）
  () => items.filter(...), [items, activePath]);

const pickFolder = useCallback( // 稳定函数引用（往子组件传时防误触发重渲）
  (p: string) => {...}, []);

const inputRef = useRef<HTMLInputElement | null>(null); // 不触发渲染的可变盒子
```

坑位：useEffect 依赖数组漏依赖 → eslint `react-hooks/exhaustive-deps` 会吼；
异步函数不能直接当 effect（用 `void (async () => {...})()` 包，仓库里到处是）。

### 组件与 props

```tsx
function DocCard({ doc, onEdit }: { doc: KnowledgeDoc; onEdit: () => void }) {
  return <Card onClick={onEdit}>…</Card>;
}
```

数据**自上而下**流动，子组件通过回调上报事件。跨页面的全局状态才用
zustand（见[对应篇](./zustand-react-router.md)）。

## 在本仓库

| 想看什么 | 打开 |
|----------|------|
| 一个中等复杂页面的完整形态 | `web/src/pages/Knowledge.tsx`（树/弹窗/拖拽/检索俱全） |
| 受控表单 + 提交 | 同文件 `DocEditor` |
| 类型化 API 层 | `web/src/api/knowledge.ts`、`client.ts` |
| 基础组件库 | `web/src/components/ui/`（Card/Chip/Button/PageHeader/EmptyState） |
| i18n 惯用法 | `const { tr } = useI18n()` → `tr('中文','English')` |

本仓库 UI 红线（详见 AGENTS.md）：复用 ui/ 组件不手搓；zinc 骨架 + indigo
主操作 + 四个语义色；克制（不满屏彩底、禁 animate-pulse/发光/hover:scale）。

## 实用指引

```bash
cd web
npm run dev          # 热更新开发（/api 代理见 vite.config.ts）
npm run typecheck    # 全量类型检查（CI 同款）
```

- 新页面先抄成熟页骨架（Alerts/Devices/Monitor），别从空白开始；
- 列表 key 用稳定 id，不用数组下标；
- 事件处理里调 async：`onClick={() => void submit()}`；
- `cn()`（`web/src/lib/cn.ts`）做条件 class 拼接：`cn('base', active && 'bg-zinc-800')`。

## 学习资料

- [react.dev 官方教程](https://react.dev/learn)（新版，直接讲 hooks）
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
- [React TypeScript Cheatsheet](https://react-typescript-cheatsheet.netlify.app/)
