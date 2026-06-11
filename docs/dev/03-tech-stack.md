# 03 · 技术栈

## 后端（Go）

| 领域 | 选型 | 备注 |
|------|------|------|
| 语言 | Go 1.24（`.tool-versions`） | 云端 cgo（ONNX 嵌入），边端 `CGO_ENABLED=0` 纯静态 |
| HTTP 框架 | [chi](https://github.com/go-chi/chi) | REST 路由手写在 `internal/*/server/`，无 grpc-gateway |
| API 契约 | Protobuf + [buf](https://buf.build) | `api/*.proto` 是唯一契约源；`make proto` 生成，产物不提交；CI 跑 `buf breaking` |
| ORM | GORM | 启动时 `AutoMigrate` 对账 schema，**没有独立 migration 步骤** |
| 数据库 | MySQL（默认）/ SQLite（本地快速开发） | `ONGRID_DB_DIALECT` 切换；iam 的 data 目录名 `sqlite/` 是 ADR-005 枢轴遗留 |
| 隧道 | [geminio](https://github.com/singchia/geminio) + [frontier](https://github.com/singchia/frontier) broker | edge 出向拨号；云端监听 `:40012` |
| 日志 | `log/slog` 结构化 + `trace_id` | ERROR 必须带完整 error chain |
| 并发 | `errgroup` + context 贯穿 | 所有 IO 函数第一个参数是 `context.Context` |
| 鉴权 | JWT（`internal/pkg/auth` / `authzmw`） | `org_id` 只从 claims 取；密码 bcrypt/argon2id |
| 配置 | `internal/pkg/config` | 环境变量驱动，`ONGRID_*` 前缀，`.env` 注入 |

## AI / Agent

| 领域 | 选型 | 备注 |
|------|------|------|
| LLM 接入 | `internal/pkg/llm`（多 provider） | Anthropic / OpenAI / GLM（智谱）/ DeepSeek / Gemini / Kimi，支持热路由切换 |
| Agent 内核 | 自研 tool-calling loop（`manager/biz/aiops/agent`） | OpenAI 风格 function calling，工具注册表 + scope 校验 |
| 子代理提示词 | `agents/*.md`（frontmatter + markdown） | coordinator 按 `when_to_use` 调度 specialist / investigator |
| Skill | `internal/skill` 注册表 + `skills/` 定义 | 边端经 `execute_skill` RPC 分发；builtin 靠 `init()` 注册 |
| 向量库 | Qdrant（`internal/pkg/qdrantx`） | 知识库 / 代码检索 RAG |
| 嵌入 | fastembed-go + ONNX Runtime（本地 BGE 模型），可换云端 provider | `ONGRID_EMBEDDING_PROVIDER=local`；模型由 `make fetch-embedding-model` 预拉 |
| Web 搜索 | SearXNG（compose 内自托管） | agent 的 web search 工具后端 |
| 文档抽取 | `internal/pkg/docextract` | 知识库入库管线 |

## 可观测性（既是产品功能，也是自身监控）

| 组件 | 用途 | 接入封装 |
|------|------|----------|
| Prometheus | 指标存储；接收 manager remote_write（edge 推上来的开放集 exporter 样本） | `internal/pkg/promquery` / `promwrite` / `prom` |
| Loki | 日志（edge 侧 promtail 采集推送） | `internal/pkg/logquery` |
| Tempo | 分布式链路（edge 侧 otelcol-contrib） | `internal/pkg/tracequery` |
| Grafana | 仪表盘，nginx 反代 + 复用 ongrid 会话鉴权 | `internal/pkg/grafana`、`manager/biz/grafana` |
| node_exporter / process-exporter | 主机 / 进程指标源，随 edge 包分发 | edge `plugins/hostmetrics`、`procmetrics` |
| 自身指标 | `/healthz` `/readyz` `/metrics`（云端 :9100，边端 :9101） | `internal/pkg/httpserver` |

## 前端（web/）

| 领域 | 选型 | 备注 |
|------|------|------|
| 框架 | React 18 + TypeScript 5 + Vite 5 | SPA，`type: module` |
| 样式 | Tailwind CSS 3 | 中性骨架 zinc、主操作 indigo、语义色仅 emerald/amber/red/sky（详见 AGENTS.md） |
| 状态 | zustand | `web/src/store/`（auth / chatSessions / mode / modelSelection …） |
| 路由 | react-router-dom 6 | 路由表集中在 `App.tsx` |
| 图表 | recharts | 监控 / 报表曲线 |
| 拓扑图 | @xyflow/react + @dagrejs/dagre | Topology 页面的图布局 |
| 终端 | xterm.js（fit / web-links addon） | 浏览器 SSH / WebShell |
| Markdown | react-markdown + remark-gfm | 聊天 / 报告渲染 |
| 测试 | Vitest + Testing Library + MSW + jsdom | `npm run test` |
| Lint | ESLint（typescript-eslint） | `--max-warnings 50` |

## 构建 / 交付

| 领域 | 选型 |
|------|------|
| 构建入口 | Makefile（唯一入口，CI / Dockerfile / README 都只调 make target） |
| 镜像 | `deploy/Dockerfile.ongrid`（debian-slim + ONNX）、`Dockerfile.ongrid-edge`（distroless static）、`Dockerfile.web`（SPA + nginx）、`Dockerfile.frontier` |
| 本地全栈 | `deploy/docker-compose.yml`（mysql, ongrid, nginx, frontier, prometheus, loki, tempo, searxng, qdrant, grafana） |
| 发布物 | `make package` → 自包含 `ongrid-vX.Y.Z-linux-{amd64,arm64}.tar.xz`（镜像 + edge 二进制 + 采集器 + install.sh） |
| Go lint | golangci-lint + go-arch-lint（BC 边界） |
| 版本管理 | asdf（`.tool-versions`） |

## 项目规范体系

- 全仓库遵循 [gospec](https://github.com/singchia/gospec)（Go 后端 SDLC 规范），
  红线摘要在 [`AGENTS.md`](../../AGENTS.md)。
- 重大设计决策以 ADR 编号引用（散见代码注释，如 ADR-003 租户上下文、ADR-005 私有 MVP 枢轴、
  ADR-007 frontier、ADR-008 前端镜像、ADR-012/013/015 logs/traces 插件、ADR-024 edge 升级 bundle）。
- 输出语言默认中文（注释 / 文档 / commit message）。
