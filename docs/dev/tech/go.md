# Go 语言核心

> 本仓库后端 100% 是 Go（1.24）。本篇覆盖读懂 / 写好这份代码所需的语言核心，
> 不是完整教程——零基础先过一遍 [A Tour of Go](https://go.dev/tour/)。

## 为什么是 Go

单二进制交付（edge 一个静态文件扔到任何主机就能跑）、并发原语适合「云端同时管
几百条隧道」、编译期类型检查 + 极快的构建。

## 核心概念

### 1. 包与可见性

- 一个目录 = 一个包；**大写开头 = 导出**，小写 = 包内私有。没有 class，组织单位是包。
- `internal/` 下的包只能被本模块 import——这是 Go 内置的封装机制，
  本仓库的 BC 边界（`internal/iam` 等）建立在它之上。

### 2. 错误处理：值而不是异常

```go
v, err := doSomething(ctx)
if err != nil {
    return nil, fmt.Errorf("load doc: %w", err) // %w 包装，保留错误链
}
```

- `%w` 包装后可用 `errors.Is(err, errs.ErrNotFound)` / `errors.As` 判断链上任意一环；
- 本仓库错误码定义在 `internal/pkg/errs`，biz 层返回
  `fmt.Errorf("%w: title required", errs.ErrInvalid)`，server 层据此映射 HTTP 状态码；
- 红线：禁止 `_ = fn()` 静默吞错（确实要丢弃必须注释说明）；
  错误**要么处理要么传播**，不要又记日志又往上抛（会重复打日志）。

### 3. context.Context

贯穿一切 IO 的取消/超时/元数据载体。规则：所有涉及 IO 的函数**第一个参数**是
`ctx context.Context`；不要存到 struct 里。本仓库在中间件里把身份（org_id、用户）
塞进 ctx（`internal/pkg/tenantctx`），biz 层从 ctx 取。

```go
ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
defer cancel()
```

### 4. goroutine 与 channel

```go
go func() { ... }()        // 轻量线程
ch := make(chan int, 8)    // 通信管道
```

实践中本仓库更常用 **errgroup**（带错误传播和 ctx 取消的 goroutine 组）：

```go
eg, ctx := errgroup.WithContext(ctx)
eg.Go(func() error { return runHTTP(ctx) })
eg.Go(func() error { return runTunnel(ctx) })
return eg.Wait() // 任一出错 → ctx 取消 → 全部退出
```

`cmd/ongrid-edge/main.go` 就是这个形状。红线：共享状态必须加锁
（`sync.Mutex`），测试必须能过 `-race`。

### 5. 接口在消费方定义

Go 接口是隐式实现的（duck typing）。本仓库的关键架构约定：
**biz 层声明它需要的 repo 接口，data 层「碰巧」实现它**——依赖方向因此从
data 指向 biz，而不是反过来。看 `internal/manager/biz/knowledge/repo.go` 体会。

### 6. 构造函数注入

没有 DI 框架。`NewUsecase(repo Repo, embed Embedder) *Usecase` 这样的构造函数
在 `cmd/ongrid/main.go` 里手工串联。红线：禁止全局可变变量；`init()` 只做注册
（如 `internal/skill/builtin` 的执行器注册），禁止 IO。

### 7. slog 结构化日志

```go
log.Info("doc updated", "doc_id", id, "org_id", orgID)
log.Error("sync failed", "err", err) // ERROR 必须带完整错误链
```

封装在 `internal/pkg/logger`。红线：敏感字段（密码、token、用户消息内容）禁止入日志。

### 8. 表驱动测试

本仓库测试的标准形状：

```go
func TestNormalizePath(t *testing.T) {
    cases := []struct{ name, in, want string }{
        {"trim slashes", "/网络/DNS/", "网络/DNS"},
        {"blank", "  ", ""},
    }
    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            if got := normalizePath(tc.in); got != tc.want {
                t.Fatalf("got %q want %q", got, tc.want)
            }
        })
    }
}
```

## 在本仓库

| 想看什么 | 打开 |
|----------|------|
| errgroup + 优雅退出 | `cmd/ongrid-edge/main.go` |
| 接口在消费方 + 用例层 | `internal/manager/biz/knowledge/usecase.go` |
| 错误码与包装 | `internal/pkg/errs`、任意 biz 的 `fmt.Errorf("%w: ...")` |
| 表驱动测试 | `internal/manager/biz/aiops/tools/*_test.go` |

## 实用指引

```bash
go test ./internal/manager/biz/alert/... -run TestX -v   # 单测一个函数
go test -race ./...                                      # 提 PR 前必跑
go vet ./... && make lint                                # 静态检查
go doc github.com/go-chi/chi/v5 Router                   # 查任何依赖的文档
```

坑位提醒：

- slice / map 是引用语义，返回内部 slice 给调用方要想清楚会不会被改；
- `for i, v := range` 的 `v` 是副本（Go 1.22 起每轮迭代变量是新的，闭包捕获已安全）;
- 时间统一 `time.Time` + UTC（看 biz 层到处的 `time.Now().UTC()`）；
- 不要在公共 API 边界用 `any`（解码等不可避免处就近注释）。

## 学习资料

- [A Tour of Go](https://go.dev/tour/) · [Effective Go](https://go.dev/doc/effective_go)
- [Go by Example](https://gobyexample.com/)（errgroup/context/channel 各有一页）
- 《100 Go Mistakes and How to Avoid Them》——团队 review 意见的高频出处
