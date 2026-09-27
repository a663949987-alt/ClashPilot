# ClashPilot

ClashPilot 是一个面向 Windows 的 Clash / Mihomo 进程规则管理与流量验证工具。

## 功能

- 用 `PROCESS-NAME` 管理“指定应用走代理”的规则
- 自动追加 `MATCH,DIRECT`，让其他流量保持直连
- 每次写入或恢复前创建完整配置快照
- 通过当前用户注册表控制 Clash 客户端开机启动
- 读取 External Controller 的实时连接、命中规则和代理链
- 对比 Windows 已建立 TCP 连接，标记受管进程的疑似绕行
- 原子写入 YAML；写入前后均执行语法校验
- 支持拖入、选择或粘贴 `.exe` 与 `.lnk` 快捷方式

## 三种执行模式

- **兼容模式**：只写 `PROCESS-NAME`，不调整 TUN 参数，适合旧版 Clash 内核或兼容性优先的环境。
- **严格模式**：同时写 `PROCESS-PATH` 和 `PROCESS-NAME`，并启用 `auto-route`、`strict-route` 与严格进程识别。
- **强制模式**：在严格模式之上，为每个受管程序创建 Windows 防火墙出站规则，阻止其从 Wired、Wireless 物理接口直连。应用规则和撤销规则时需要一次管理员授权；Clash/TUN 不可用时，受管应用会断网而不是泄漏。为避免误伤 TUN/VPN 虚拟网卡，不封锁可能承载虚拟适配器的 `RemoteAccess` 类型。

## 开发运行

```powershell
pnpm install
pnpm start
```

## 构建 Windows 安装包与便携版

```powershell
pnpm dist
```

生成文件位于 `dist` 目录。

## Clash / Mihomo 准备

配置中需开启 External Controller，例如：

```yaml
external-controller: 127.0.0.1:9090
secret: "your-secret"
find-process-mode: strict
```

建议继续使用 TUN 模式。应用修改配置后，需要在 Clash 客户端中重新载入配置，具体方式取决于所用客户端。

## 检测边界

“疑似绕行”通过对比 Clash Controller 连接与 Windows 已建立 TCP 连接得出，是启发式结论。UDP/QUIC、系统服务代发、虚拟网卡 NAT 映射等情况可能造成误报。它适合定位问题，但不能替代完整的数据包捕获审计。

强制模式的防火墙规则统一归入 `ClashPilot Forced Mode` 组；切换回兼容或严格模式并再次应用配置时，应用会请求管理员授权并移除该组规则。
