# systemd/ —— 让它像「云上专属机器」一样一直在线

> 公众号「AI之境」

一条命令装好：

```bash
sudo bash scripts/install-systemd.sh
```

| 单元 | 干什么 |
|---|---|
| `pi-bot-cn.service` | 网关常驻：每个对话一个 `pi --mode rpc` 进程、飞书长连接、本地测试通道（只听 127.0.0.1:8787）。挂了 2 秒后自动拉起（`Restart=always`）。停机时先把没发完的话写进 Outbox，再让 pi-memory 写好退出小结。 |
| `pi-bot-cn-health.timer` | 每分钟访问一次 `/health`，连续两次失败就重启网关。 |
| `pi-bot-cn-backup.timer` | 每天 03:30 把记忆、会话、Outbox 打包到 `~/pi-bot-cn-data/backups/`，保留 14 天（不含密钥）。 |
| `pi-bot-cn-env.path` | 盯着 `~/.config/pi-bot-cn/env`，你一改（比如新填飞书凭证）就自动重启网关。 |

常用命令：

```bash
systemctl status pi-bot-cn                 # 状态
journalctl -u pi-bot-cn -f                 # 实时日志
curl -s 127.0.0.1:8787/health              # 健康检查（含飞书连接状态、待发消息数）
node gateway/cli.mjs send test "你好"      # 本地测试通道发一条
node gateway/cli.mjs watch test            # 看回复
systemctl list-timers | grep pi-bot        # 定时任务
```

数据都在 `~/pi-bot-cn-data/`：`memory/`（长期记忆）、`sessions/`（对话）、`outbox/`（待发消息）、`logs/`（`gateway.jsonl`、`interrupts.jsonl`）。

注意：重启一次大约 6～9 秒（要等 pi-memory 写完退出小结），这期间飞书长连接会短暂断开，恢复后自动重连，没发出去的消息会补发。
