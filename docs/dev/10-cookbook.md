# 10 · 常见开发任务 Cookbook

> 「我要做 X，该碰哪些文件、按什么顺序」。每个配方都按依赖方向从里往外写，
> 与 arch-lint 的约束一致。动手前快速过一遍 [02 总体架构](./02-architecture.md)。

## 配方 1：新增一个 REST API

以 manager BC 为例（iam 同构）：

1. **契约**：若是新资源/破坏性变更，先改 `api/manager/<domain>/v1/*.proto`，
   `make proto` 重新生成（生成物不提交）；
2. **model**：`internal/manager/model/` 定义/扩展领域实体；
3. **biz**：`internal/manager/biz/<domain>/` 写用例逻辑；需要持久化时
   **在 biz 侧定义 repo 接口**（消费方定义接口）；
4. **data**：`internal/manager/data/<domain>/` 实现 repo（GORM）；
5. **server**：`internal/manager/server/<domain>/http.go` 加 chi handler，
   带齐 `@Summary / @Router / @Success` Swagger 注释，响应 `{code, message, data}`；
6. **装配**：`cmd/ongrid/main.go` 把 repo → biz → service → handler 串起来挂路由；
7. **前端**：`web/src/api/<domain>.ts` 加客户端函数；
8. **自查**：`make test-race && make arch-lint`，新逻辑带单测。

> 坑：service 层不得 import data；`org_id` 不进请求体（中间件从 JWT 注入）。

## 配方 2：新增一个 agent 工具

参照 `internal/manager/biz/aiops/tools/query_promql.go` 这对文件：

1. `<name>.go`：纯逻辑，依赖构造函数注入，可独立单测；
2. `<name>_basetool.go`：包装成 basetool——名称、**给 LLM 看的描述**（什么时候
   用、参数怎么填，写得越具体调用越准）、参数 JSON schema、scope 要求；
3. `registry.go` 注册；
4. `<name>_basetool_test.go` 单测（参数校验、错误路径至少各一条）；
5. 工具要在主机上执行时：云端只负责把 RPC 经 `pkg/tunnel` 推给 edge，真实现写在
   `internal/edgeagent/`，并过 `cmdpolicy` 安全评审（保持只读、接审计）。

> 调整 agent 的「行为」（什么时候调谁、输出格式）优先改 `agents/*.md` 提示词，
> 不要先动内核。

## 配方 3：新增一个前端页面

1. 先翻 Alerts / Devices / Monitor 三个成熟页对齐骨架：
   `PageHeader` + `Card` + `divide-y` 行 + `EmptyState`；
2. `web/src/pages/Foo.tsx` 新建页面；`web/src/App.tsx` 注册路由
   （旧路径迁移时保留 `Navigate replace` 重定向）；
3. API 调用放 `web/src/api/foo.ts`（统一走 `client.ts`），页面不直接 fetch；
4. 文案全部 `tr('中文', 'English')`；
5. 侧边栏入口在 `web/src/components/Sidebar.tsx`；
6. 验证：`npm run typecheck && npm run test && npm run build` +
   headless Chrome 截图实看（涉主题改动 light/dark 各一张）。

> 弹窗用 `components/Modal.tsx`（支持 `size` / `resizable`）；语义色只有
> emerald/amber/red/sky，走 `Chip` 的 `tone`。

## 配方 4：新增/修改数据表字段

Schema 由 GORM `AutoMigrate` 在启动时对账（**没有 migration 文件**）：

- 加字段：model 上加列即可，重启自动建列；给老数据想好零值语义；
- 改类型/删字段：AutoMigrate **不会**删列或改窄类型——需要写一次性迁移逻辑或接受
  遗留列，并在 PR 里说明；
- 切记 `parseTime=true` 已在 DSN 中，时间字段用 `time.Time` + UTC。

## 配方 5：新增一个 LLM provider / 模型

`internal/pkg/llm` 是**OpenAI 形状的薄客户端**（红线：不做 provider 抽象）：

- 新 provider 只要其 API 兼容 OpenAI chat/completions，就是配置问题
  （base_url + api_key + 模型名），落在设置页（`biz/setting`）；
- eino 路由层（`eino_routing.go`）按 provider id 分发，新增 id 在
  `RoutingChatModel` 里挂；
- 红线复述：Prom label 禁 user_id/org_id/session_id；禁日志记用户消息内容；
  不自动重试（工具不幂等）。

## 配方 6：新增一条 e2e 测试

1. 在 `docs/test/e2e-catalog.md` 找到/新增对应编号条目；
2. `tests/e2e/<feature>_test.go`，文件头 `//go:build e2e`；
3. 默认用 fakes（不依赖外部凭证）；要打真实外部服务的分支用
   `E2E_LIVE_ALL=1` + `secrets.local.env` 守门；
4. 测试自己创建的数据必须清理；
5. `make test-e2e` 跑通后更新 catalog 的「实现」列。

## 调试指南

```bash
# 看云端日志（compose 栈）
docker logs -f ongrid --tail 100

# 进 MySQL
docker exec -it ongrid-mysql mysql -uongrid -pongrid ongrid

# 看 qdrant collection（知识库）
curl -s localhost:6333/collections | jq   # 若端口未映射: docker exec ongrid-qdrant ...

# 前端开发：vite 热更新（代理 /api → 本地后端，见 web/vite.config.ts）
cd web && npm run dev

# 改了前端要让运行中的 compose 栈生效（SPA 烤在镜像里）：
docker compose -f deploy/docker-compose.yml build nginx
docker compose -f deploy/docker-compose.yml up -d nginx
# 然后浏览器强刷（旧 chunk 有缓存）

# 改了后端：
docker compose -f deploy/docker-compose.yml build ongrid
docker compose -f deploy/docker-compose.yml up -d ongrid

# 单跑一个 Go 测试 / 一个前端测试
go test ./internal/manager/biz/knowledge/... -run TestUpdateDoc -v
cd web && npx vitest run src/pages/Knowledge.test.tsx
```

常见症状速查：

| 症状 | 先查 |
|------|------|
| 前端改了没生效 | 是不是只改了源码没重建 nginx 镜像；浏览器缓存 |
| skill 全部 unknown skill | edge 的 main.go 少了 `_ "internal/skill/builtin"` blank import |
| arch-lint 报错 | service 直接 import 了 data，或跨 BC import |
| 知识库接口 5xx | qdrant 没起 / 嵌入 provider 未配（`ONGRID_EMBEDDING_API_KEY`） |
| 登录 401 循环 | refresh token 过期逻辑，看 `web/src/api/client.ts` 的 401 分支 |
| vitest 全挂 localStorage 错误 | Node 22+ webstorage 全局问题，`web/src/test/setup.ts` 已兜底，别删 |
