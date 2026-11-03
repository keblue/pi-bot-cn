# skills/

Agent Skills（`SKILL.md` 标准）。MVP 与第二阶段划分与规划页一致。

## MVP

| 目录 | 触发 | 说明 |
|---|---|---|
| `onboarding/` | 配对后自动；「记住：…」 | 问称呼、城市、作息等，写入记忆 |
| `morning-brief/` | 每天 08:00；「来份早报」 | 天气、日程、待办、要你拍板的事 |
| `daily-review/` | 每天 22:00；「复盘一下」 | 今日汇总 + 明天最重要的一件事 |
| `cn-research/` | 「查一下…」 | 中文搜索，结论带出处 |
| `office-docs/` | 「做个表 / PPT / Word」 | python-docx / openpyxl / python-pptx / reportlab（MIT/BSD） |
| `feishu-workbench/` | 「约个会」「建个文档」 | 调用 `@larksuite/cli`；外发邀请需审批 |
| `reminders/` | 「明天 9 点提醒我…」 | 大白话 → 定时任务 |

## 第二阶段（目录稍后补）

`watch/`（盯梢）、`qq-mail/`、`browser-ops/`、`cn-image-gen/`。

各子目录目前仅有 README 占位；正式技能实现后放入 `SKILL.md` 与脚本。
