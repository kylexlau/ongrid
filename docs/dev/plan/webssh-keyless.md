# WebSSH 免登录改造方案（保留本地 SSH，安装时提前做好免密）

> 状态：**已实现**（分支 `feat/webssh-keyless`）。本文是该改造的设计依据，落地细节以代码为准。
>
> **方向**：架构不动——仍是「manager 端 SSH 客户端 → edge 转发 → 本机 `127.0.0.1:22` sshd」。只做两件事：
> 1. 安装 `ongrid-edge` 时**提前把免密（公钥）认证配好**，之后 WebSSH 无需密码。
> 2. 前端**去掉登录弹窗**，进页面直连。
>
> 关键收益：edge 转发器、manager 的 PTY/resize/审计/并发限制**全部不改**，只换「认证方式 + 登录用户来源」。改造量远小于「edge 直起 PTY」的方案。
>
> **已定参数**：单一 manager 密钥；登录用户跟随安装者 `SUDO_USER`（回退 root）；走本机 `127.0.0.1:22` sshd 公钥登录。

## 1. 现状

```
浏览器 WS ─(open: ssh_user/ssh_pass)─▶ manager(SSH 客户端, 密码认证) ─stream─▶ edge ─TCP─▶ 127.0.0.1:22 sshd
```

- 弹窗：`web/src/pages/DeviceShell.tsx` 的 `ConnectModal` 采集 `ssh_user/ssh_pass/端口`。
- 认证：`internal/manager/server/webshell/http.go` 用 `ssh.Password(openFrame.SSHPass)`，`User=openFrame.SSHUser`，`InsecureIgnoreHostKey`。
- edge：`internal/edgeagent/webshell/handler.go` 裸字节转发到 `127.0.0.1:22`。
- 安装：`deploy/install/edge/install.sh` 写 env + systemd unit。
- HostInfo 上报：`internal/pkg/tunnel/messages.go` `HostInfo{hostname/os/...}`。

## 2. 改造后

```
浏览器 WS ─(open: cols/rows/term, 无凭据)─▶ manager(SSH 客户端, 公钥认证) ─stream─▶ edge ─TCP─▶ 127.0.0.1:22 sshd
                                            │ 用 manager 私钥 ssh.PublicKeys
                                            │ User = 该设备安装时配置的固定用户(edge 上报)
```

- 私钥**只在 manager**（SSH 客户端在 manager 侧，私钥不离开）。
- 公钥在**安装时**写进目标用户的 `~/.ssh/authorized_keys`（提前做好免密）。
- 登录用户**单一固定**，安装时确定（默认 `SUDO_USER`→`root`），edge 上报给 manager 当默认 SSH 用户。
- 前端无弹窗、无凭据输入。

## 3. 详细设计

### 3.1 manager：持有 WebSSH 密钥对 + 公钥认证

- **密钥对**：manager 首次启动若不存在则生成一对 `ed25519`，PKCS#8 PEM 持久化到 `system_settings`（`category=webssh`，`key=private_key`，`sensitive=true`），generate-if-absent。私钥按敏感凭据管理（仅 manager 进程可读，不入日志/镜像/仓库——AGENTS.md 红线）。
  - 实现：`internal/manager/biz/webshell/keys.go` `LoadOrCreateKeys`。
- **公钥分发端点**：公开 `GET /api/v1/edge/webssh-authorized-key`（`/api` 反代到 manager，install.sh 匿名拉取；返回的是公钥，公开安全），返回**单行 authorized_keys 文本**：

  ```
  from="127.0.0.1,::1" ssh-ed25519 AAAA... ongrid-webssh
  ```

  `from="127.0.0.1,::1"` 是免费的强加固：该 key **只允许从本机发起**——而 WebSSH 的 SSH 连接正是 edge 在主机本地 dial `127.0.0.1:22`，sshd 看到的源就是 127.0.0.1。即使 key 泄露也无法从别的机器直接用。
  - 实现：`server/webshell/http.go` `RegisterPublic` / `serveAuthorizedKey`。
- **认证改造**（`http.go`）：
  - `Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)}`，并在浏览器仍传了密码时追加 `ssh.Password(...)`（back-compat / break-glass）。
  - `User` 优先 open 帧的 `ssh_user`（旧前端），否则 `edge.ShellUser`（上报值），再否则 `root`。
  - `openMsg` 的 `ssh_user/ssh_pass/ssh_host` 改为可选；删掉「ssh_user/ssh_pass required」校验。
  - `ready` 帧带回 `ssh_user`，供前端展示。
  - PTY 申请、resize（`WindowChange`）、`Shell`、exit、审计、并发限制、idle、kill —— **全部不动**。审计 `SSHUser` 字段改填实际登录用户。

### 3.2 edge：上报登录用户

- config（`internal/pkg/config/config.go` `EdgeConfig`）加 `ShellUser`（`ONGRID_EDGE_SHELL_USER`）。
- `HostInfo` 加 `shell_user` 字段（`internal/pkg/tunnel/messages.go`）；`edgebiz.Config.ShellUser` 在 register 时写入 `info.ShellUser`。
- manager `HandleRegister` 把上报值落到 `edges.shell_user`（新列，gorm AutoMigrate，模仿 `agent_version` 的持久化写法）。
- **edge 转发器 `handler.go` 一行不改**（仍转发到 127.0.0.1:22）。

### 3.3 安装：提前做好免密（install.sh）

1. 解析 `--shell-user=<user>`，默认 `SUDO_USER`，回退 `root`；写 `ONGRID_EDGE_SHELL_USER=<user>` 到 env。
2. `curl` 拉取 `https://<http-addr>/api/v1/edge/webssh-authorized-key`。
3. 幂等写入目标用户 `~/.ssh/authorized_keys`：解析 home（`getent passwd`）；`install -d -m 700`；文件 `chmod 600` + `chown`；按 `ongrid-webssh` 标记去重后追加。
4. sshd 前置自查（仅告警不阻断）：`PubkeyAuthentication yes`；目标用户=root 时 `PermitRootLogin` 需 `prohibit-password`/`without-password`。
5. `--no-webssh-key` 可跳过；`--uninstall` 清除 `ongrid-webssh` 行。

> 不碰 sshd 主配置、不重启 sshd（仅动 authorized_keys），是最「快捷」且对存量主机最稳的做法。

### 3.4 前端：去掉弹窗，自动连接

`web/src/pages/DeviceShell.tsx`：

- 删除 `ConnectModal` 整块及 `user/password/port/remember/localStorage` 逻辑。
- 进页面（拿到 token）后**自动** `openConnection`（一次性 ref 守卫），`open` 帧只带 `cols/rows/term`。
- 顶部状态条显示登录用户（取自 `ready` 帧 `ssh_user`）。
- `auth_error` 文案弱化为「认证失败（请确认该设备已安装 WebSSH 免密公钥）」；保留红 banner + 「重连」。
- `webshell.ts`：`ShellOpenFrame` 凭据字段改可选；`ready` 帧加 `ssh_user`。

## 4. 安全考量

- **私钥即长期免密凭据**：相比「每次会话手输密码」，改成「manager 持 key 可无人值守登录」。这把闸门完全压到 **manager RBAC**（`device:shell/exec` casbin）+ manager 私钥保密。上线前须确认授权策略够紧。
- `from="127.0.0.1,::1"` 限制：key 仅本机可用，泄露也无法远程直连。
- 私钥存储：仅 manager 进程可读，不入日志/镜像/仓库（红线）；存 `system_settings` sensitive 列。
- 单 key 隐患：单 key 泄露=所有主机。加固路线见 §6。
- 目标用户默认跟随 `SUDO_USER`（通常非 root），降低直接 root shell 面。

## 5. 兼容与回滚

- 双 auth method 并存：浏览器若仍传密码，密码作为 fallback——新前端不传，老流程不破。
- 存量 edge（未上报 `shell_user`）：manager 回退 `root`；需重跑一次安装命令装入公钥（已写进 `docs/install/edge.md`）。
- 回滚 authorized_keys：`--uninstall` 或删除带 `ongrid-webssh` 标记的那一行。
- 灰度：先单台装好 key + 验证直连，再铺开。

## 6. 待办 / 加固路线（非 MVP）

1. **每-edge key**：manager 按 access-key 发该 edge 专属公钥，隔离更好；当前是单一 manager key。
2. **SSH 证书**：manager 持 CA，连接时签发 1~2 分钟短期证书，安装时只配 `TrustedUserCAKeys`。无常驻 authorized_key、自动过期，但要动 sshd 配置 + reload。
3. **tarball 安装器** `install-edge.sh` 同步 `--shell-user`（当前仅 curl-pipe `install.sh` 主流程做了）。
4. **UI 视觉验证**：AGENTS 要求的 headless 截图（light+dark）需在有 live edge + 可 SSH 目标主机的环境补做。

## 7. 关联实现文件

- 后端：`internal/manager/biz/webshell/keys.go`(+`keys_test.go`)、`internal/manager/server/webshell/http.go`、`internal/manager/model/setting/model.go`、`internal/manager/model/edge/model.go`、`internal/manager/biz/edge/{repo,usecase}.go`、`internal/manager/data/edge/store/edge.go`、`cmd/ongrid/main.go`
- edge：`internal/pkg/tunnel/messages.go`、`internal/pkg/config/config.go`、`internal/edgeagent/biz/agent.go`、`cmd/ongrid-edge/main.go`
- 安装/文档：`deploy/install/edge/install.sh`、`docs/install/edge.md`
- 前端：`web/src/pages/DeviceShell.tsx`、`web/src/api/webshell.ts`
