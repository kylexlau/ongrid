# JWT 认证 & casbin RBAC

> 自托管、无公开注册：首个 admin 由环境变量播种，之后管理员在 UI 里建用户。
> 认证 = JWT（`internal/pkg/auth`），授权 = casbin RBAC（`internal/pkg/authzmw`）。

## 核心概念

### 1. JWT 是什么

三段 base64：`header.payload.signature`。服务端用密钥签名，**无状态校验**——
不查库就能确认「这个 token 是我签的、没过期、claims 没被改」。

```
payload(claims) 大致形如：
{ "sub": "<user_id>", "org_id": ..., "role": "admin", "exp": 1760000000 }
```

要点：

- claims 是**明文**（base64 不是加密），别放敏感数据；
- 签名保证的是**完整性**，所以服务端可以信任 claims 里的 `org_id` / `role`
  ——这就是 ADR-003「org_id 永远来自 JWT 而非请求体」的依据；
- 无状态的代价：没有服务端吊销，所以 access token 要**短命**。

### 2. 双 token 刷新链路

| token | 寿命 | 用途 |
|-------|------|------|
| access_token | 短 | 每个请求的 `Authorization: Bearer` |
| refresh_token | 长 | access 过期后换新（`POST /auth/refresh`） |

前端链路在 `web/src/api/client.ts`：401 → 自动 refresh →
重放原请求（带 `_retryingAfterRefresh` 防循环）→ refresh 也失败才登出。
`refreshInFlight` 单飞，避免并发 401 触发多次刷新。

### 3. 中间件流水线

```
请求 → pkg/auth（解析+验签 JWT，身份写入 ctx）
     → pkg/authzmw（casbin：这个 role 能不能对这个资源做这个动作）
     → server/middleware/audit（写敏感操作审计）
     → handler
```

biz 层从 ctx 拿身份（`pkg/tenantctx`），不接触 HTTP 概念。

### 4. casbin 一分钟

casbin 把「谁(sub) 能对什么(obj) 做什么(act)」抽成策略数据 + 匹配模型：

```
p, admin, knowledge:repo, write      # 策略（存 MySQL casbin_rule 表，gorm-adapter）
m = g(r.sub, p.sub) && r.obj == p.obj && r.act == p.act   # 匹配模型
```

代码里以 `h.writeMW("knowledge:repo")` 这类资源标签声明一个路由需要的权限，
中间件拿当前 role 问 casbin 放不放行。改权限 = 改策略数据，不用改代码。

### 5. 密码与密钥红线

- 密码哈希 bcrypt/argon2id（`internal/pkg/passwd`），禁止 MD5/SHA1；
- 密钥/token 不入日志、不入仓库、不入镜像；
- edge 的认证是另一套：AK/SK（注册时下发），走隧道层校验，与用户 JWT 无关。

## 在本仓库

| 想看什么 | 打开 |
|----------|------|
| JWT 签发/校验 | `internal/pkg/auth/jwt.go` |
| 认证中间件 | `internal/pkg/auth/middleware.go` |
| casbin 中间件 | `internal/pkg/authzmw/middleware.go` |
| 前端 token 管理 | `web/src/store/auth.ts`（zustand persist）+ `api/client.ts` |
| admin 播种 | `deploy/README.md` "First login"（`ONGRID_ADMIN_EMAIL/PASSWORD`） |
| edge AK/SK | `internal/manager/server/edgeauth/`、`biz/edge` |

## 实用指引

```bash
# 拿 token 调试 API
TOKEN=$(curl -sk -X POST https://localhost/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<admin>","password":"<pwd>"}' | jq -r .access_token)

# 看 claims（本地调试足够；不要把生产 token 贴进任何在线解码网站）
echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null | jq
```

新增受保护路由的套路：handler 注册时挂对应资源标签的鉴权中间件；
新角色/新资源 → 补 casbin 策略；写单测覆盖「无权限 → 403」分支
（参考 `tests/e2e/auth_rbac_test.go`）。

## 学习资料

- [jwt.io Introduction](https://jwt.io/introduction)
- [casbin 文档（中文）](https://casbin.org/zh/docs/overview)——读 RBAC 模型一章即可
