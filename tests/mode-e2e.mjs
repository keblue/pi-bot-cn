// 授权模式测试（本地通道）：每次询问 ↔ 始终允许，灾难级命令照样问，「以后都允许」顺手放行当前这条。
// 用法：PIBOT_DATA_DIR=... PIBOT_LOCAL_PORT=... node tests/mode-e2e.mjs <step>
//   view | always | auto-rm | critical | ask | ask-then-always | reset
import { readFileSync, existsSync } from "node:fs";
const H = process.env.HOME, D = process.env.PIBOT_DATA_DIR || `${H}/pi-bot-cn-data`, BASE = `http://127.0.0.1:${process.env.PIBOT_LOCAL_PORT || 8787}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : []);
const gw = () => lines(`${D}/logs/gateway.jsonl`);
const chat = process.env.CHAT || "mode-test";
const send = (text) => fetch(`${BASE}/inbound`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: chat, text }) }).then((r) => r.json());
async function until(fn, ms) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(300); } return null; }
const n0 = gw().length, m0 = lines(`${D}/channel-local/${chat}.jsonl`).length;
const evs = (name) => gw().slice(n0).filter((e) => e.event === name && e.chatId === chat);
const settled = () => until(() => evs("agent_settled").length && Date.now() - evs("agent_settled").at(-1).ms > 2500 && !s_busy() && true, 150000);
let lastStart = 0;
const s_busy = () => { const st = evs("agent_start").length, se = evs("agent_settled").length; return st > se; };
const step = process.argv[2];
const out = { step };
if (step === "view") out.r = await send("授权设置");
else if (step === "always") out.r = await send("以后不用问我了");
else if (step === "ask") out.r = await send("恢复每次询问");
else if (step === "auto-rm") {
	out.r = await send("请直接运行这一条命令：mkdir -p /tmp/pbt-mode/a && touch /tmp/pbt-mode/a/1 && rm -rf /tmp/pbt-mode/a ；然后用一句话告诉我结果。");
	await until(() => evs("agent_settled").length, 150000);
	out.dirGone = !existsSync("/tmp/pbt-mode/a");
} else if (step === "critical") {
	out.r = await send("请直接运行这一条命令：sudo shutdown -c （取消计划中的关机，没有就算了），然后用一句话告诉我结果。");
	const req = await until(() => evs("approval_request")[0], 120000);
	out.request = req && { critical: req.critical, mode: req.mode, why: req.why };
	await sleep(1500);
	out.deny = await send("先别");
	await until(() => evs("agent_settled").length, 120000);
} else if (step === "ask-then-always") {
	out.r = await send("请直接运行这一条命令：mkdir -p /tmp/pbt-mode/b && rm -rf /tmp/pbt-mode/b ；然后用一句话告诉我结果。");
	const req = await until(() => evs("approval_request")[0], 120000);
	out.request = req && { critical: req.critical, mode: req.mode, why: req.why };
	await sleep(1500);
	out.always = await send("以后都允许");
	await until(() => evs("agent_settled").length, 150000);
	out.dirGone = !existsSync("/tmp/pbt-mode/b");
}
await sleep(1500);
out.botSaid = lines(`${D}/channel-local/${chat}.jsonl`).slice(m0).map((m) => `[${m.purpose}${m.final ? " final" : ""}${m.state ? ":" + m.state : ""}] ${String(m.note ?? m.text ?? "").slice(0, 160).replace(/\n/g, " ")}`);
out.log = gw().slice(n0).filter((e) => /^approval_/.test(e.event)).map((e) => `${e.event} ${e.to ?? e.state ?? e.mode ?? ""}${e.critical ? " critical" : ""} ${e.how ?? ""}`.trim());
out.modesFile = existsSync(`${D}/approval-modes.json`) ? JSON.parse(readFileSync(`${D}/approval-modes.json`, "utf8")) : null;
console.log(JSON.stringify(out, null, 1));
