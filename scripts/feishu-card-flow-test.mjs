// 在主人的飞书私聊里走一遍卡片流程（只调 API，不开长连接，不影响正在运行的网关）：
// 「…」占位卡(带停止) → 原地变审批卡（三个按钮）→ 审批结果 → 模型那句话并进审批卡 → 回答卡流式 → 收尾去按钮
// → 「…」卡被喊停（只去按钮，不撤回）→ 灾难级审批卡（两个按钮）→ 授权设置卡 → 点了之后原地更新
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
	["approval_note", { purpose: "approval", approvalId: "t-a1", command: "rm -rf ~/demo（测试，不会执行）", why: "会删除文件（可能不止一个）", timeoutMs: 600000, state: "denied", note: "（测试）好，那先不删。" }],
	["answer_stream", { purpose: "card", cardKey: "t2", text: "（测试）这是回答卡，正在输出时下面有「停止」按钮", final: false }],
	["answer_final", { purpose: "card", cardKey: "t2", text: "（测试）这是回答卡，正在输出时下面有「停止」按钮。\n\n说完了，按钮已去掉。", final: true }],
	["placeholder2", { purpose: "card", cardKey: "t3", text: "…", final: false }],
	["stop_no_text", { purpose: "card", cardKey: "t3", text: "…", final: true }],
	["approval_critical", { purpose: "approval", approvalId: "t-a2", command: "sudo shutdown -h now（测试，不会执行）", why: "会关机或重启服务器", critical: true, timeoutMs: 600000, state: "pending" }],
	["approval_critical_denied", { purpose: "approval", approvalId: "t-a2", command: "sudo shutdown -h now（测试，不会执行）", why: "会关机或重启服务器", critical: true, timeoutMs: 600000, state: "denied" }],
	["mode_card", { purpose: "mode_card", modeCardId: "t-m1", mode: "ask" }],
	["mode_card_switched", { purpose: "mode_card", modeCardId: "t-m1", mode: "always", note: "（测试）好，以后一般的危险命令我直接做，不再问你；删整个系统、格式化磁盘、关机、改我自己密钥这类还是会先问。" }],
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
