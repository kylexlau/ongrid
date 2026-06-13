# 12 · 技能 / 助理 / 知识库的存储位置

> 这三块的「定义」散落在不同地方——有的在 Go 代码里编译进二进制，有的是
> 磁盘上的 markdown / manifest 文件，有的在 MySQL，有的在 Qdrant 向量库。
> 经常有人问「我改了 XX 为什么不生效 / 它到底存哪」，本文一张表讲清楚。
>
> 关系表的字段细节见 [11 数据库表结构设计](./11-database-schema.md)；本文聚焦
> 「定义来自哪、改了走哪条路生效」。

## 一句话总览

| 子系统 | 定义来源 | 运行时载体 | UI 能改吗 |
|--------|---------|-----------|-----------|
| 技能 Skills | 代码 / 磁盘技能包 | 内存 registry（`skillcore`） | 否（只读查看） |
| 助理 Agents | 代码 / `agents/*.md` / `user_agents` 表 | 内存 registry（`AgentRegistry`） | 仅 `user` 来源 |
| 知识库 Knowledge | 用户录入 / git 仓库 / 内置 vault | Qdrant 向量库（+ MySQL 注册表） | 仅 `manual`/`upload` 来源 |

共同点：三者运行时都在**内存 registry / 向量库**里，磁盘 / 代码 / DB 是它们的
*source of truth*。改 source 后能否热生效，取决于有没有「写回内存」的路径
（见下）。

---

## 技能 Skills

技能 = 一个自包含的能力（探测端口 / 读文件 / 跑命令 / 查 PromQL …）。
框架从 metadata 自动派生 LLM 工具注册、HTTP API、UI 表单、权限门、审计。

### 两类来源

| 来源 | 存哪 | 怎么加载 |
|------|------|---------|
| **原生技能** | Go 代码：`internal/manager/biz/aiops/tools/*.go`、`internal/skill/builtin/`、各 BC 的 host 技能 | 编译进二进制，`init()` 里 `skillcore.Register` 进**全局内存 registry** |
| **技能包**（subprocess） | 磁盘：`skill.json` manifest + 可执行文件 | 启动时 `skillcore.LoadDirs` 扫描配置目录，注册成 `SubprocessSkill`；JSON 经 stdin/stdout 交换 |

技能包的扫描目录（`cmd/ongrid/main.go`）：

- `ONGRID_BUILTIN_SKILLS_ROOT`（默认 `./skills`）— 仓库自带的 `skills/`（bash / host-files / restart-service …）
- `ONGRID_SKILLS_ROOT`（默认 `/var/lib/ongrid/skills`）— marketplace 安装的技能包落地处

### 安装记录在哪

通过 marketplace 安装的技能包，**元数据**记在 MySQL `installed_skills` 表
（`(tenant_id, pack_id)` 唯一、`manifest_sha256` 内容锁），但**技能定义本体**
仍是磁盘上的 `skill.json` + 二进制——表只是安装锁 + 启动校验，不存技能逻辑。

### 为什么 UI 不能编辑

技能定义要么在编译进二进制的 Go 代码里，要么在磁盘技能包文件里，运行时全在
内存 registry，没有「可写的技能存储层」。所以技能页只做**查看**
（`web/src/pages/Skills.tsx` 点行打开只读详情）。要改原生技能改代码重新编译；
要改技能包改磁盘文件重启。

---

## 助理 Agents（Personas）

助理 = coordinator 可委派的一个 persona（SRE 专家 / 网络专家 / 审核员 …），
带 system prompt、工具白名单、模型、轮数上限等。运行时都在
`AgentRegistry`（`internal/manager/biz/aiops/chatruntime/agent_registry.go`）。

### 三种来源（`chatruntime.Agent.Source`）

| Source | 存哪 | 怎么加载 | UI 能改 |
|--------|------|---------|---------|
| `builtin` | Go 代码（programmatic `Add`，如虚拟的 `default` coordinator） | 编译进二进制，启动 `registry.Add` | 否 |
| `disk` | `agents/*.md`（frontmatter + markdown body 即 system prompt） | 启动从 `ONGRID_BUILTIN_AGENTS_ROOT`（默认 `./agents`）解析进 registry | 否（文件是真相） |
| `user` | **MySQL `user_agents` 表** | 通过 `/v1/agents/custom` CRUD；保存时 `AgentRegistry.Replace` 热更新内存 | ✅ 增删改 |

仓库自带的 `disk` persona：`agents/` 下的 `incident-investigator` /
`specialist-sre` / `specialist-ops` / `specialist-compute` /
`specialist-network` / `specialist-disk` / `reviewer` / `reporter`。

### 改了怎么生效

- **`user` 助理**：UI（`web/src/pages/Agents.tsx`）直接增删改 → DB 行 + 内存
  `Replace`，无需重启。
- **`disk` 助理**：UI 上「删除」只是把它从内存 registry 摘掉（session-scoped），
  `.md` 文件还在，**重启自动加载回来**。真要改它就改 `agents/*.md` 重启。
- **`builtin` 助理**：改代码重新编译。

### UI 的查看 / 编辑模式

参照知识库 vault 文档的「只读 + 复制为组织文档」语义：

- 点助理卡片 → **只读详情**（完整 system prompt / when_to_use / 工具 / 模型）
- `user` 来源 → 详情里「编辑」直接改 DB 行
- `builtin`/`disk` 来源 → 不可在线改，提供「复制为自定义助理」**fork** 出一份
  `user` 草稿再编辑（落到 `user_agents` 表）

---

## 知识库 Knowledge

知识库的**文档本体不在 MySQL**——是本文最容易踩坑的点。

### 存储分工

| 内容 | 存哪 | 说明 |
|------|------|------|
| 文档正文 / 标题 / tags / 向量 | **Qdrant**（collection `ongrid_knowledge`） | 每篇文档 = 一个 qdrant point；正文是 point 的 payload，不是 SQL 行 |
| git 仓库注册 | MySQL `knowledge_repos` | url / branch / last_synced_at；仅注册信息，文件本体不在这 |
| git clone 用 SSH 私钥 | MySQL `ssh_identities` | private_key/passphrase 落库前 AES 加密 |

Qdrant collection 名固定为 `ongrid_knowledge`
（`internal/manager/biz/knowledge/usecase.go` 的 `CollectionName`）；
point id 由 `md5(payload.url)` 高 64 位派生，sync 之间稳定。

### 文档的四种来源（`source_type`）

| source_type | 来自哪 | 落地路径 |
|-------------|--------|---------|
| `manual` | 用户在 UI 粘贴 markdown | 直接 chunk→embed→Qdrant |
| `upload` | 用户上传文件（md/txt/pdf/docx） | `docextract` 抽取 → chunk→embed→Qdrant |
| `repo` | 注册的 git 仓库文件 | clone 到 `ONGRID_KNOWLEDGE_REPO_DIR` 下 `repoDir(id)`，扫描→chunk→embed→Qdrant |
| `vault` | 平台内置知识库 | go:embed 进二进制，见下 |

> 录入 / 上传 / 同步的文件最终都进 Qdrant 当向量检索；磁盘上的 clone 目录只是
> 同步管线的中转，不是检索数据源。

### 内置 vault 的特殊性

平台内置知识库（runbook 素材）来自上游 `github.com/ongridio/vault`，但
**不是运行时 git clone**——markdown 用 `go:embed all:builtin_vault` 直接嵌进
二进制（`internal/manager/biz/knowledge/builtin_vault.go`）。`Sync()` 把嵌入的
文件落到 repo 目录，再走和 repo 一样的 scan→chunk→embed→Qdrant 管线。

注意：嵌入的是**文件**，不绕过 Qdrant——向量化仍需 embedder
（`ONGRID_EMBEDDING_*`）+ 活着的 Qdrant。上游 vault 更新后用
`scripts/sync-builtin-vault.sh` 重新 vendor 嵌入副本并提交。

### UI 的查看 / 编辑模式

- `manual`/`upload`（组织自有）→ 可编辑表单，直接改
- `vault`/`repo`（同步重建，改了会被覆盖）→ 只读阅读器 + 「复制为组织文档」
  fork 成 `manual` 再编辑

（助理的 fork 语义就是照搬这套。）

### 备份边界

备份知识库 = 备份 **Qdrant 卷**（`qdrant_data`）+ MySQL（`knowledge_repos` /
`ssh_identities`）。只备 MySQL 会丢掉所有文档正文。

---

## 速查：改了 X 怎么生效

| 想改 | 改哪 | 生效方式 |
|------|------|---------|
| 原生技能逻辑 | `internal/.../tools/*.go` | 重新编译 |
| 技能包 | 磁盘 `skill.json` + 二进制 | 重启（重新 `LoadDirs`） |
| 内置 / 预置助理 | `agents/*.md` | 重启；或 UI fork 成自定义助理 |
| 自定义助理 | UI / `user_agents` 表 | 即时（`Replace` 热更新） |
| 组织知识文档 | UI（manual/upload） | 即时（写 Qdrant） |
| 内置 vault 内容 | 上游 vault + `scripts/sync-builtin-vault.sh` | 重新编译 + Sync |

## 相关文档

- [05 AI Agent 体系](./05-agent-system.md) — coordinator / specialist / 工具注册
- [11 数据库表结构设计](./11-database-schema.md) — `user_agents` / `knowledge_repos` / `installed_skills` / `ssh_identities` 字段
- [07 部署与数据](./07-deploy-and-data.md) — 存储卷与备份边界
