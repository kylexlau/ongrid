# Tempo & OpenTelemetry（链路追踪）

> 链路这条线：用户应用按 OpenTelemetry 标准吐 trace → edge 随包分发的
> otelcol-contrib 收集转发 → Tempo 存储 → Web `/traces` 页 / agent 的
> `query_traceql` 工具查询。

## 核心概念

### 1. trace / span 模型

```
trace（一次请求的完整旅程，trace_id 全局唯一）
└── span: gateway  140ms
    └── span: order-svc  120ms        ← parent/child 构成树
        ├── span: mysql query  80ms   ← 慢在这里
        └── span: redis get     2ms
```

- **span** = 一段有起止时间的操作，带 attributes（kv）、status、event；
- **context propagation**：trace_id/span_id 通过 HTTP header
  （W3C `traceparent`）跨服务传递——断链多半是中间某跳没透传 header；
- 日志里打 `trace_id`（slog 约定字段）就能从日志跳到链路，反之亦然——
  这是 RCA 关联 m/l/t 的接缝。

### 2. OpenTelemetry 三件套

| 组件 | 角色 |
|------|------|
| SDK（各语言） | 应用内创建 span、采样、导出 |
| OTLP 协议 | 统一的传输格式（gRPC :4317 / HTTP :4318） |
| Collector（otelcol） | 接收 → 处理（采样/脱敏/打标）→ 转发的管道 |

edge 的 traces 插件（ADR-013/015）管理 **otelcol-contrib** 进程：
用户应用把 OTLP 打到本机 collector，collector 加上 `edge_id` 等资源属性后
转发给云端 Tempo。contrib 发行版 ~200MB，操作员可换自编 OCB 精简版。

### 3. TraceQL 高频句式

```traceql
{ resource.service.name = "order-svc" && duration > 500ms }   # 慢请求
{ span.http.status_code >= 500 }                              # 错误
{ resource.edge_id = "42" } | select(span.db.statement)       # 投影字段
```

形状：`{ 条件 }` 选 span，`&&/||` 组合，`duration`、`span.*`（span 属性）、
`resource.*`(资源属性) 三类可查字段记住就够入门。

### 4. Tempo

只按 trace_id 索引 + TraceQL 扫描的廉价存储（与 Loki 同哲学）。
本地栈不映射端口，经 manager 的查询封装访问。

## 在本仓库

| 想看什么 | 打开 |
|----------|------|
| 查询封装 | `internal/pkg/tracequery` |
| agent 工具 | `internal/manager/biz/aiops/tools/query_traceql.go` |
| edge 侧 collector 管理 | `internal/edgeagent/plugins/traces` |
| manager 自身 OTel 接入 | `internal/pkg/tracing` |
| 前端 | `web/src/pages/Traces.tsx`、`web/src/api/traces.ts` |
| collector 分发 | Makefile `fetch-otelcol`（linux-only） |

## 实用指引

- 验证链路通不通：在被管主机上对本机 collector 发一条测试 span
  （`telemetrygen traces --otlp-insecure --traces 1`，或任意 OTel demo 应用
  指向 `localhost:4317`），然后 Web /traces 页按服务名查；
- 排查断链三板斧：① 应用真的装了 SDK 且导出到 4317？② collector 进程在跑？
  （edge 插件状态 / 进程列表）③ header 在网关/代理处被吃了？
- 给 manager 自己加 span：用 `pkg/tracing` 的 tracer，span 名 `<包>.<动作>`，
  错误记得 `span.RecordError(err)`。

## 学习资料

- [OpenTelemetry 文档 · Concepts](https://opentelemetry.io/docs/concepts/)
- [Tempo · TraceQL](https://grafana.com/docs/tempo/latest/traceql/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)（理解 traceparent）
