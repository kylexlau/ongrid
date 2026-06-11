# Protobuf & buf

> `api/*.proto` 是所有公共契约的唯一来源。REST handler 手写（没有 grpc-gateway），
> 但请求/响应类型、隧道消息载荷都由 proto 生成，跨语言、可做破坏性变更检查。

## 为什么是 proto + buf

- 一份 schema 同时约束 Go 结构体与未来可能的多语言客户端；
- `buf breaking` 在 CI 里挡住不兼容变更（删字段、改类型）；
- 比手写 JSON struct 多一层「先想清楚契约再写代码」的纪律。

## 核心概念

### 1. message 与字段编号

```protobuf
syntax = "proto3";
package ongrid.manager.aiops.v1;

message GetDocRequest {
  uint64 id = 1;        // 编号是序列化身份，一旦发布永不复用
}
message GetDocResponse {
  Doc doc = 1;
}
```

- **字段编号不可改、不可复用**——这是兼容性的根基；删字段要 `reserved`；
- proto3 所有字段默认 optional 语义（零值不序列化）；
  显式 `optional` 仅在「字段是否被显式设置」有业务含义时用（本仓库约定：能省则省）。

### 2. service（即使不跑 gRPC）

```protobuf
service AiopsService {
  rpc GetDoc(GetDocRequest) returns (GetDocResponse);
}
```

本仓库约定：**每个 RPC 独立 Request/Response 类型**（即使为空），为前向兼容留位。
`api/tunnel/v1` 特别说明：它只用 proto 做隧道消息的序列化，**不是 gRPC 服务**。

### 3. buf 工作流

```
api/
├── buf.yaml        # 模块定义 + lint/breaking 规则
├── buf.gen.yaml    # 生成器配置（protoc-gen-go 等）
└── gen/            # 生成产物，.gitignored，不提交
```

```bash
make proto              # buf generate（无 buf 时回退 protoc）
cd api && buf lint      # 风格检查
cd api && buf breaking --against '.git#branch=main'   # 破坏性变更检查（CI 也跑）
```

## 在本仓库

| 想看什么 | 打开 |
|----------|------|
| 命名与目录约定 | `api/README.md`（必读，约定都在这） |
| 包名规则 | `ongrid.<bc>[.<subdomain>].v<major>`，如 `ongrid.manager.edge.v1` |
| go_package 规则 | `api/gen/<path>/v1;<name>v1` |
| 隧道载荷 | `api/tunnel/v1/tunnel.proto` |

关键约定复述（来自 api/README）：

- ID 用 `uint64`，时间用 `google.protobuf.Timestamp`，token 用 `string`；
- `org_id` 永远不是请求字段（JWT 注入），响应里只读回显可以；
- 一个 service 的所有 message 放同一个 `.proto` 文件，不拆；
- 破坏性变更 → 新建 `v2` 目录，v1 只能加非破坏内容。

## 实用指引

- 改 proto 的标准流：改 `.proto` → `make proto` → 编译报错处跟着改 Go 代码 →
  `buf breaking` 自查；
- 生成代码**永远不要手改**（在 `api/gen/`，本来也不提交）；
- 加字段选下一个未用编号即可，与字段顺序无关；
- JSON 序列化时 proto 字段名是 snake_case → 生成的 Go struct tag 已处理，
  REST 响应直接复用这些类型可保持命名一致。

## 学习资料

- [Protobuf 语言指南 (proto3)](https://protobuf.dev/programming-guides/proto3/)
- [buf 文档](https://buf.build/docs/)——重点读 breaking 与 lint 两章
