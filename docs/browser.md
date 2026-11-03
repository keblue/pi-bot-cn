# 自己的浏览器（技术说明）

> pi-bot-cn · AI之境

## 组成

| 部分 | 文件 | 说明 |
|---|---|---|
| 浏览器常驻服务 | `systemd/pi-bot-cn-browser.service`、`scripts/browser.sh` | Xvfb 虚拟屏幕 `:99` + Chromium（独立用户目录，登录状态长期保留），调试端口只监听 `127.0.0.1:9223` |
| 安装 | `scripts/install-browser.sh` | 装 Xvfb、Chromium、字体，配 AppArmor，装 systemd 服务 |
| 工具扩展 | `extensions/browser.ts` | 用 playwright-core 通过 CDP 连上浏览器，注册 13 个 `browser_*` 工具 |
| 页面快照 | `browser/snapshot.js` | 把页面变成带编号的文字（`[e12] 按钮「登录」`），包括内嵌框架（`f2e5`）；没文字的按钮借用旁边的文字 |
| 录像转 GIF | `browser/make-gif.mjs` | 任务结束后把截屏帧压成约 1～2MB 的 GIF |
| 密码库 | `scripts/vault.mjs` | `~/pi-bot-cn-data/vault.json`（权限 600），按名字 + 域名存账号密码 |
| 测试 | `tests/browser-e2e.mjs`、`tests/demo-sites/otp-server.mjs` | 本地通道 + 真模型跑完整任务，自动回答审批卡和验证码；喵喵银行是本地短信验证码演示站 |

## 工具

`browser_open` 打开网址 · `browser_snapshot` 读页面（可 `find` 关键词、`offset` 翻页）· `browser_click` 点（`ref` 编号，或 `text` 按文字点）· `browser_type` 打字（可 `submit` 回车）· `browser_press` 按键 · `browser_select` 选下拉框 · `browser_scroll` 滚动 · `browser_wait` 等待 · `browser_screenshot` 截图（`send=true` 发给主人，每次任务最多 4 张）· `browser_download` 下载 · `browser_list_secrets` / `browser_fill_secret` 从密码库填 · `browser_ask_owner` 问主人（验证码用 `secret=true`）

## 付款审批

`browser_click`、`browser_type(submit)`、`browser_press(Enter)` 前都判断是不是付款：

- 强信号：按钮文字像 Pay、Place order、支付、付款、提交订单、立即购买……直接算付款
- 弱信号：Finish、确认、提交、完成…… 只有在**付款页**（网址/标题像 checkout、支付、订单，且页面上有卡号框或「合计 / Total」金额）才算
- 是付款：先把按钮标红、截图，发 `critical:true` 的审批卡（「在 www.saucedemo.com 点「Finish」（Total: $8.63）」），**始终允许模式也会问**；拒绝或超时就不点

防绕过：bash 命令、或 write/edit 写出的脚本里出现 `:9223`、`connectOverCDP`、`playwright`、`puppeteer`、`xdotool`、`DISPLAY=:99` 等，按灾难级规则处理（`config/interrupt-policy.json` 的 `alwaysAskRules`），任何模式都要主人批准。注意：这是尽力而为的拦截，bash 与浏览器同属一个系统用户，不是强隔离。

## 密码和验证码

- 密码：`node scripts/vault.mjs set saucedemo saucedemo.com`（交互输入，不进 shell 历史）。模型只能看到名字和域名，`browser_fill_secret` 在扩展里直接填进去；域名对不上拒绝填
- 验证码：`browser_ask_owner(secret=true, ref=输入框)`，主人回复的内容直接填进网页，日志只记长度

## 录像

每次网页任务一个目录 `~/pi-bot-cn-data/recordings/<时间>-<序号>/`：`frames/`（CDP screencast，每秒最多 5 帧，最多 1500 帧）、`shots/`（关键截图）、`steps.json`、`session.gif`。

可调：`PIBOT_REC_MIN_GAP_MS`（默认 200）、`PIBOT_REC_MAX_FRAMES`（默认 1500）、`PIBOT_BROWSER_MAX_SHOTS`（默认 4）。

## 看屏幕（不开公网端口）

```bash
# 服务器上（只监听本机）
sudo apt install -y x11vnc
x11vnc -display :99 -localhost -nopw -forever &
# 自己电脑上
ssh -L 5900:127.0.0.1:5900 ubuntu@你的服务器
# 然后用 VNC 客户端连 127.0.0.1:5900
```

## 跑测试

```bash
# 隔离实例（不碰正式机器人、不连飞书）跑一个场景
node tests/browser-e2e.mjs saucedemo "帮我登录 saucedemo 买最便宜的那件" --approve 可以 --mode always
node tests/demo-sites/otp-server.mjs 8798 &
node tests/browser-e2e.mjs otp "登录喵喵银行 http://127.0.0.1:8798/login 看余额，验证码问我" --code-file /tmp/otp-code.txt
```

结果写在 `tests/out/browser-<名字>.json`（时间线、机器人说的话、录像目录）。

## 实测（2026-11-03，腾讯云上海）

| 场景 | 结果 | 用时 |
|---|---|---|
| saucedemo 登录 + 下单（始终允许模式） | ✅ 付款审批卡在 Finish 弹出 | 45 秒 / 15 步 |
| 喵喵银行短信验证码登录 | ✅ 验证码 0 次进日志 | 22 秒 / 5 步 |
| 什么值得买比价 → CSV | ✅ | 310 秒 / 21 步 |
| 京东直接搜索 | ❌ 要登录，模型最后转用其他站 | — |
| Stripe 测试收银台 | ⚠️ 审批卡正常，点支付后停在处理中（大陆网络） | — |

可直接访问：saucedemo.com、checkout.stripe.dev（页面能开，支付不稳）、cn.bing.com、smzdm.com、baidu.com（搜索会出验证码）。打不开：google.com、demoblaze.com、the-internet.herokuapp.com。
