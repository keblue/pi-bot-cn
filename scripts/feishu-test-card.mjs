// 给主人直接发一张测试卡片（JSON 2.0，被拒自动退回 1.0），并回读确认 msg_type=interactive。
// 用法（不会打印任何凭证）：
//   set -a; . ~/.config/pi-bot-cn/env; set +a; node scripts/feishu-test-card.mjs
// 主人点卡片上的按钮后，正在运行的网关会在 gateway.jsonl 里记一条 feishu_card_ping（走 card.action.trigger 长连接回调）。
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFeishuChannel } from "../gateway/channels/feishu.mjs";

const pendingFile = join(homedir(), ".config/pi-bot-cn/owner_open_id.pending");
const owner = (process.env.PI_BOT_OWNER_OPEN_IDS || "").split(",")[0].trim() || (existsSync(pendingFile) ? readFileSync(pendingFile, "utf8").trim() : "");
if (!owner) throw new Error("没有 owner open_id");
const logs = [];
const log = (event, f) => logs.push({ event, ...f });
const ch = await createFeishuChannel({ log, dataDir: "/tmp" });
const r = await ch.sendTestCard(owner);
console.log(JSON.stringify({ ok: r.ok, cardSchema: r.v === 2 ? "2.0" : "1.0", readBackMsgType: r.readBack, events: logs.map((l) => l.event) }));
process.exit(0);
