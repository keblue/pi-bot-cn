# config/

| 文件 | 作用 |
|---|---|
| `env.template` | env 模板，只有变量名，没有密钥。复制到 `~/.config/pi-bot-cn/env` 并 `chmod 600` 后自己填 |
| `interrupt-policy.json` | 插话说法（停 / 改成… / 做完再…）、飞书里哪些系统回执静音（`quietChannels`），以及危险命令审批 `approval` |
| `deps.lock.json` | 第三方包锁定版本 |

`interrupt-policy.json` 的 `approval` 部分：

| 字段 | 说明 |
|---|---|
| `rules` | 普通危险命令（`sudo`、`rm -rf 某目录`、`git push`……）。「每次询问」模式下先问，「始终允许」模式下直接执行 |
| `alwaysAskRules` | 灾难级命令（删整个系统、格式化磁盘、关机、停掉机器人、碰机器人自己的密钥……）。**任何模式都先问** |
| `protectedPathPatterns` | 用 write / edit 工具改这些文件（`.env`、`.ssh`、私钥）一律先问，同样属于灾难级 |
| `alwaysPatterns` / `askPatterns` / `settingsPatterns` | 主人切换授权模式的说法：「以后不用问我了」「恢复每次询问」「授权设置」 |
| `approvePatterns` / `denyPatterns` | 审批时直接回的「可以」「先别」 |
| `timeoutMinutes` | 多久没回就当作不同意（默认 10 分钟） |

授权模式按主人保存在 `~/pi-bot-cn-data/approval-modes.json`（重启不丢）；没设置过时用 env 的 `PI_APPROVAL_MODE`（`ask` / `always`，默认 `ask`）。

定时任务（早报、复盘）的配置还在规划中。
