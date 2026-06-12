# chi 路由 & REST Handler

> 云端 HTTP API 用 [go-chi/chi](https://github.com/go-chi/chi)：一个只做路由的
> 轻量库，handler 就是标准库的 `http.HandlerFunc`，没有框架魔法。

## 为什么是 chi

与 `net/http` 完全兼容（任何标准中间件直接可用）、路由树支持 URL 参数与分组、
零反射零代码生成。项目刻意不用重框架——分层约束靠 gospec 而非框架目录。

## 核心概念

### 1. 路由与参数

```go
r := chi.NewRouter()
r.Get("/v1/knowledge/docs", h.listDocs)
r.Get("/v1/knowledge/docs/{id}", h.getDoc)     // URL 参数
r.Post("/v1/knowledge/docs", h.createDoc)

func (h *Handler) getDoc(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")               // 取参数
    ...
}
```

### 2. 中间件

签名 `func(http.Handler) http.Handler`，洋葱模型：

```go
r.Use(authmw)                                  // 全局
r.With(h.writeMW("knowledge:repo")).Post(...)  // 单路由
r.Group(func(r chi.Router) { r.Use(adminOnly); ... })  // 分组
```

本仓库的关键中间件链：`pkg/auth`（JWT 解析 → 身份入 ctx）→
`pkg/authzmw`（casbin 权限）→ `manager/server/middleware/audit.go`（审计）。

### 3. Handler 三段式（本仓库约定）

```go
func (h *Handler) createDoc(w http.ResponseWriter, r *http.Request) {
    // 1. 解析 + 校验入参（json.Decode / URL 参数）
    // 2. 调 service / biz（业务不写在 handler 里）
    // 3. 统一响应 {code, message, data}；错误经 errs 映射状态码
}
```

每个 handler 必须带 Swagger 注释（CI 检查的对象是约定而非工具强制）：

```go
// @Summary 创建知识文档
// @Router  /v1/knowledge/docs [post]
// @Success 200 {object} docOut
```

### 4. 错误 → HTTP 状态码

biz 返回 `errs.ErrInvalid` / `ErrNotFound` / `ErrForbidden` 包装错误，
server 层用 `errors.Is` 翻译成 400/404/403，正文仍是 `{code, message}`。
**不要在 biz 里出现 http.StatusXxx**——那是 server 层的词汇。

## 在本仓库

| 想看什么 | 打开 |
|----------|------|
| 一个完整的 domain server | `internal/manager/server/knowledge/http.go` |
| 中间件写法 | `internal/pkg/authzmw/middleware.go`、`manager/server/middleware/` |
| 路由总装 | `cmd/ongrid/main.go`（搜 `chi.NewRouter`） |
| multipart 上传 | `server/knowledge/http.go` 的 upload handler |
| uint64 ID 的 JSON 处理 | 同上 `json:"id,string"`（防 JS 2^53 溢出） |

## 实用指引

- 新增路由后用 `curl` 直接打本地：
  ```bash
  TOKEN=$(curl -sk -X POST https://localhost/api/v1/auth/login -H 'Content-Type: application/json' \
    -d '{"email":"...","password":"..."}' | jq -r .access_token)
  curl -sk https://localhost/api/v1/knowledge/docs -H "Authorization: Bearer $TOKEN" | jq
  ```
- 响应里的大整数 ID 一律 `uint64` + `,string` tag，前端按 string 处理；
- 分页/过滤参数从 `r.URL.Query()` 取，**`org_id` 永远不从请求取**（ADR-003）；
- handler 单测看 `server/knowledge/http_test.go`：`httptest.NewRecorder()` +
  造一个假 usecase 即可，不需要起真服务器。

## 学习资料

- [chi README](https://github.com/go-chi/chi)（一页就是全部 API）
- 标准库 [net/http 文档](https://pkg.go.dev/net/http)——chi 之下全是它
