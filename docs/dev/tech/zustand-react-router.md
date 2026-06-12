# zustand & React Router

> 全局状态用 zustand（约 6 个小 store），路由用 react-router-dom 6
> （路由表集中在 `App.tsx`）。两者都刻意用得很薄。

## zustand

### 1. 心智模型

一个 store = 一个 hook，状态 + 修改函数放一起，没有 action/reducer 仪式：

```ts
export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      setSession: (s) => set({ token: s.access_token, ... }),
      logout: () => set({ token: null, ... }),
    }),
    { name: 'ongrid.auth', storage: createJSONStorage(() => localStorage) },
  ),
);
```

### 2. 两种用法

```ts
// 组件内：订阅（selector 收窄，只在所选片段变化时重渲）
const role = useAuth((s) => s.role);

// 组件外（API 层/工具函数）：直接取，不订阅
export function getToken() { return useAuth.getState().token; }
```

`client.ts` 在 401 时调 `useAuth.getState().logout()` 就是第二种。

### 3. persist 中间件

`useAuth` 持久化到 localStorage key `ongrid.auth`，存储形状是
`{"state":{...},"version":0}`——写测试 / 调试时按这个形状 seed。
其余 store（`mode` 主题、`chatSessions`、`modelSelection`…）在
`web/src/store/`，有的用 zustand、有的就是 localStorage + 自定义事件
（`i18n/locale.ts` 的做法），**别为简单偏好引入新 store**。

### 4. 什么状态放哪（本仓库取舍）

| 状态 | 放哪 |
|------|------|
| 单页面 UI 状态（弹窗开关、表单值） | 组件 `useState` |
| 跨页面、需持久（登录态、主题、locale） | zustand persist / localStorage |
| 服务端数据（列表、详情） | 页面内 fetch + useState（没有引 react-query，保持简单） |

## React Router 6

### 1. 路由表（App.tsx 集中式）

```tsx
<Routes>
  <Route path="/login" element={<LoginPage />} />
  <Route element={<Layout />}>                        {/* 布局路由：含登录守卫 */}
    <Route path="/devices" element={<EdgesPage />} />
    <Route path="/devices/:edgeId" element={<EdgeDetailPage />} />
    <Route path="/edges" element={<Navigate to="/devices" replace />} />  {/* 旧路径 */}
  </Route>
</Routes>
```

要点：

- `<Route element={<Layout/>}>` 嵌套 = 共享侧边栏/守卫，子页面渲染在 Layout 的
  `<Outlet/>` 里；
- 登录守卫即 Layout 里「没 token → `<Navigate to="/login"/>`」；
- **旧路径必须留 `Navigate replace` 重定向**（仓库惯例，别让书签 404）。

### 2. 组件内三件套

```tsx
const { edgeId } = useParams();            // 取 URL 参数
const navigate = useNavigate();           // 编程式跳转 navigate(`/devices/${id}`)
const [sp, setSp] = useSearchParams();    // 读写 query string
<Link to="/alerts">…</Link>               // 声明式跳转（别用 <a>，会整页刷新）
```

## 在本仓库

| 想看什么 | 打开 |
|----------|------|
| persist store 范本 | `web/src/store/auth.ts` |
| 组件外取 state | `web/src/api/client.ts`（getToken / logout） |
| 完整路由表 + 懒加载 + 重定向 | `web/src/App.tsx` |
| 守卫与布局 | `web/src/components/Layout.tsx` |
| 非 zustand 的轻量全局态 | `web/src/i18n/locale.ts`、`store/mode.ts`（localStorage + window 事件） |

## 实用指引

- 新页面 = pages/ 建文件 + App.tsx 加 `lazy` import 和 `<Route>` + Sidebar 加入口；
- 需要在 URL 上可分享的状态（过滤器、tab）放 searchParams，不放 store；
- zustand store 写单测不需要 React：直接 `useAuth.getState().setSession(...)`
  再断言 `getState()`；
- 测试里 mock 整个 store 看 `Marketplace.test.tsx` 的 `vi.mock('@/store/auth', ...)`。

## 学习资料

- [zustand README](https://github.com/pmndrs/zustand)（一页学完）
- [React Router 6 官方教程](https://reactrouter.com/en/main/start/tutorial)
