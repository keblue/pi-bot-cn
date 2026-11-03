// 在主人的飞书私聊里走一遍卡片流程（只调 API，不开长连接，不影响正在运行的网关）：
// 「…」占位卡(带停止) → 原地变审批卡 → 审批结果 → 回答卡流式 → 收尾去按钮 → 占位卡撤回
// 用法：set -a; . ~/.config/pi-bot-cn/env; set +a; node scripts/feishu-card-flow-test.mjs
import { readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFeishuChannel } from "../gateway/channels/feishu.mjs";
const chats = JSON.parse(readFileSync(join(homedir(), "pi-bot-cn-data/chats.json"), "utf8"));
const chatId = Object.entries(chats).find(([, c]) => c.channel === "feishu")?.[0];
if (!chatId) throw new Error("还没有飞书会话");
mkdirSync("/tmp/fct", { recursive: true });
const logs = [];
const ch = await createFeishuChannel({ log: (event, f) => logs.push({ event, ...f }), dataDir: "/tmp/fct" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [
	["placeholder", { purpose: "card", cardKey: "t1", text: "…", final: false }],
	["approval_pending(reuse)", { purpose: "approval", approvalId: "t-a1", command: "rm -rf ~/demo（测试，不会执行）", why: "会删除文件（可能不止一个）", timeoutMs: 600000, state: "pending", reuseCardKey: "t1" }],
	["approval_denied", { purpose: "approval", approvalId: "t-a1", command: "rm -rf ~/demo（测试，不会执行）", why: "会删除文件（可能不止一个）", timeoutMs: 600000, state: "denied" }],
	["answer_stream", { purpose: "card", cardKey: "t2", text: "（测试）这是回答卡，正在输出时下面有「停止」按钮", final: false }],
	["answer_final", { purpose: "card", cardKey: "t2", text: "（测试）这是回答卡，正在输出时下面有「停止」按钮。\n\n说完了，按钮已去掉。", final: true }],
	["placeholder2", { purpose: "card", cardKey: "t3", text: "…", final: false }],
	["recall_empty", { purpose: "card", cardKey: "t3", text: "", final: true }],
];
const out = [];
for (const [name, m] of steps) {
	const t0 = Date.now();
	try {
		await ch.send({ chatId, channel: "feishu", ...m });
		out.push({ step: name, ok: true, ms: Date.now() - t0 });
	} catch (e) {
		out.push({ step: name, ok: false, err: String(e?.message ?? e).slice(0, 160) });
	}
	await sleep(1500);
}
console.log(JSON.stringify({ steps: out, events: logs.map((l) => `${l.event}${l.v ? " v" + l.v : ""}${l.purpose ? " " + l.purpose : ""}`) }, null, 1));
process.exit(0);
