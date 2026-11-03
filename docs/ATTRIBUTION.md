# 第三方依赖归属（计划锁定，尚未内嵌）

本仓库**不** vendoring 下列项目的源码；安装时按锁定版本从 npm / PyPI / GitHub 拉取。  
版本与许可证信息来自 2026-11-03 调研（见内部笔记 `pi_feasibility.md`），发布前请再核对一次。

| 依赖 | 计划锁定版本 | 许可证 | 用途 |
|---|---|---|---|
| `@earendil-works/pi-coding-agent` | 1.5.0 | MIT | pi 主体，内置 DeepSeek |
| `@amaster.ai/pi-channels` | 0.1.35 | Apache-2.0 | 飞书长连接参考 / 备选桥（MVP 倾向自写飞书网关，对齐 Grok Bot 的频道能力） |
| `pi-schedule-prompt` | 0.4.1 | MIT | 定时与一次性任务 |
| `pi-memory` | 0.4.2 | MIT | MEMORY.md + 每日日志 |
| `pi-subagents` | 0.84.0 | MIT | 子任务拆分 |
| `@bytetrue/pi-web-search` | 0.6.1 | MIT | 中文搜索（博查等） |
| `@larksuite/cli` | 1.0.98 | MIT | 飞书日历 / 文档 / 多维表格等 |
| `@larksuiteoapi/node-sdk` | 1.76.0 | MIT | 飞书消息与卡片（审批回调） |
| `agent-browser` | 0.41.1 | Apache-2.0 | 无头浏览器（第二阶段） |
| `himalaya` | v2.2.1 | Apache-2.0 | QQ 邮箱收发（第二阶段） |
| `python-docx` | 1.2.0 | MIT | Word |
| `openpyxl` | 3.1.5 | MIT | Excel |
| `python-pptx` | 1.0.2 | MIT | PPT |
| `reportlab` | 5.1.0 | BSD | PDF |
| `@earendil-works/pi-durable` | 1.5.0 | MIT | 常驻备选（第二阶段） |
| Node.js | ≥ 22.19（建议 24） | MIT | 运行时 |

## 不会打包分发的内容

Anthropic 官方 `docx` / `xlsx` / `pptx` / `pdf` skills 为专有许可，**禁止二次分发**。本项目的 `office-docs` 使用上表 MIT/BSD Python 库自写。

## 安全相关说明

第三方包以完整系统权限运行于 pi 环境：一律锁版本，升级前人工审阅；密钥不进仓库。参考工信部对同类常驻助手配置风险的提示，默认最小权限与长连接、无多余公网端口。
