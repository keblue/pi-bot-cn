# extensions/

我们自己写的 pi 扩展（TypeScript），服务于**大陆可自建的 Grok Bot 平替**（公众号「AI之境」）。骨架阶段仅占位说明，实现后以 `*.ts` 为准。

## MVP

| 模块 | 文件（规划） | 干什么 |
|---|---|---|
| **approval-gate** | `approval-gate.ts` | 拦截发消息 / 删除 / 花钱 / 公开发布 / 改系统等敏感 `tool_call`；经 **飞书网关** 发审批卡片；批准后放行，拒绝或 30 分钟超时则取消。外发默认先起草。规则见 `config/approval-policy.json`（后续）。 |
| **bot-core** | `bot-core.ts` | 人设与说话规矩、功能菜单、`/help` `/status` `/budget`、每日花费上限、夜间静音。 |
| **feishu-gateway** | `feishu-gateway/`（薄桥进程） | 飞书聊天频道（相当于 Slack / 频道）。用官方 SDK 长连接同时收 **消息** 与 **卡片按钮**（`card.action.trigger`）；点完卡片原地变为已批准 / 已拒绝；顺带常驻跑定时。不依赖公网业务端口。 |
| **push-glue** | `push-glue.ts` | （若仍用分离桥）把定时任务结果推到飞书、去重、失败重试；推到群需审批。自写飞书网关后可能并入常驻进程。 |

## 设计要点

- pi 默认 YOLO：本扩展是「先起草、敏感动作先问你再动手」的核心体验，主对标 Grok Bot。
- 子会话若不加载扩展，必须把本目录扩展列入桥的 `bridge.extensions`（或由 gateway 统一注入）。
- **绝不**在日志或飞书消息里打印密钥。

实现进度：未开工（0.0.1 骨架）。
