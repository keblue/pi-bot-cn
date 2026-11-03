# extensions/

我们自己写的 pi 扩展（TypeScript），服务于**大陆可自建的 Grok Bot 平替**（公众号「AI之境」）。骨架阶段仅占位说明，实现后以 `*.ts` 为准。

## MVP

| 模块 | 文件（规划） | 干什么 |
|---|---|---|
| **duet-core** ✅ | `duet-core.ts` | **可打断的 bash**：同名覆盖内置 bash 工具，每条命令独立进程组 + 独立中止开关；扩展命令 `/pibot-interrupt <新要求>` 在模型流式输出中也立即执行，SIGKILL 整个进程组，并把「[被用户打断] 用户插话：…」作为工具结果交给模型；有副作用的命令（rm/mv/git push/npm install…）额外提示「可能半完成」。日志：`$PIBOT_DATA_DIR/logs/interrupts.jsonl`。实测杀进程组 3～6 ms，进程消失 15～28 ms。 |
| **approval-gate** | `approval-gate.ts` | 拦截发消息 / 删除 / 花钱 / 公开发布 / 改系统等敏感 `tool_call`；经 **飞书网关** 发审批卡片；批准后放行，拒绝或 30 分钟超时则取消。外发默认先起草。规则见 `config/approval-policy.json`（后续）。 |
| **bot-core** | `bot-core.ts` | 人设与说话规矩、功能菜单、`/help` `/status` `/budget`、每日花费上限、夜间静音。 |
| **feishu-gateway** | `feishu-gateway/`（薄桥进程） | 飞书聊天频道（相当于 Slack / 频道）。用官方 SDK 长连接同时收 **消息** 与 **卡片按钮**（`card.action.trigger`）；点完卡片原地变为已批准 / 已拒绝；顺带常驻跑定时。不依赖公网业务端口。 |
| **push-glue** | `push-glue.ts` | （若仍用分离桥）把定时任务结果推到飞书、去重、失败重试；推到群需审批。自写飞书网关后可能并入常驻进程。 |

## 设计要点

- pi 默认 YOLO：本扩展是「先起草、敏感动作先问你再动手」的核心体验，主对标 Grok Bot。
- 子会话若不加载扩展，必须把本目录扩展列入桥的 `bridge.extensions`（或由 gateway 统一注入）。
- **绝不**在日志或飞书消息里打印密钥。

实现进度：duet-core 已完成并实测；网关在 `gateway/`（pi RPC 常驻会话、插话策略、Outbox、飞书长连接通道）。其余模块待开工。
