# Loki & LogQL

> 日志这条线：被管主机的日志由随包分发的 promtail 采集推到 Loki，
> Web `/logs` 页和 agent 的 `query_logql` 工具都在上面查。

## 为什么是 Loki

「像 Prometheus 一样做日志」：**只给流的 label 建索引，不索引日志内容**——
存储便宜一个量级，代价是全文检索靠查询时暴力 grep（对运维日志场景够用）。
和 Grafana/Prometheus 同生态，label 体系可以与指标对齐（同一个 `edge_id`
能横跨 m/l/t 关联——RCA 的关键）。

## 核心概念

### 1. 流（stream）模型

一组 label 唯一确定一条流：

```
{edge_id="42", unit="nginx.service", job="systemd-journal"} → 日志行序列
```

与 Prometheus 同样的纪律：**label 必须低基数**（机器、服务单元、文件路径级别），
trace_id / user_id 这类放日志内容里，靠过滤器查。

### 2. LogQL 两段式

```logql
{edge_id="42", unit="nginx.service"}        # ① 流选择器（必须）
  |= "error"                                # ② 行过滤：包含
  != "healthz"                              #    排除
  | json                                    #    解析器：提取 JSON 字段
  | status >= 500                           #    字段条件
```

度量查询（把日志变成指标，告警常用）：

```logql
sum by (unit) (rate({edge_id="42"} |= "error" [5m]))   # 每秒错误行数
```

记两条：`|=` / `!=` / `|~`（正则）是行过滤；`rate(...[5m])` 套在流上就成了指标。

### 3. promtail 采集（ADR-012 / 015）

edge 的 logs 插件管理 promtail 进程：抓 systemd journal / 文件日志，
打上 `edge_id` 等 label 后**直推 Loki**（不经过 manager 转发）。
promtail 二进制随 release 包分发（`make fetch-promtail`），linux-only——
macOS 主机上 logs 插件自动禁用。

## 在本仓库

| 想看什么 | 打开 |
|----------|------|
| 查询封装（/logs 页与 agent 共用） | `internal/pkg/logquery` |
| edge 侧 promtail 管理 | `internal/edgeagent/plugins/logs` |
| agent 工具 | `internal/manager/biz/aiops/tools/query_logql.go` |
| 前端页面 | `web/src/pages/Logs.tsx`、`web/src/api/logs.ts` |
| Loki 服务 | `deploy/docker-compose.yml` 的 `loki`（本地栈不映射端口） |

## 实用指引

```bash
# 本地栈里直接查 Loki API（容器内 3100）
docker exec ongrid-loki wget -qO- \
  'http://localhost:3100/loki/api/v1/query_range?query={job=~".+"}&limit=5' | head -c 500

# 看有哪些 label / 值
docker exec ongrid-loki wget -qO- 'http://localhost:3100/loki/api/v1/labels'
```

写查询的实务建议：

- 永远先收窄流选择器（`edge_id` + `unit`），再上行过滤——选择器太宽 = 全量扫描；
- 时间窗口从小开（5m）逐步放大；
- 结构化日志（slog JSON）配 `| json` 解析后按字段过滤，比正则稳；
- 给告警写「日志里出现 X」类规则时用度量式 LogQL（rate + sum），不要轮询查询。

## 学习资料

- [Loki 文档 · LogQL](https://grafana.com/docs/loki/latest/query/)
- [promtail 配置参考](https://grafana.com/docs/loki/latest/send-data/promtail/)
