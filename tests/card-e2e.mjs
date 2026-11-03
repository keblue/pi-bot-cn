// 回答卡行为测试（本地通道，把 local 当成飞书那样「安静」）：
//   stop  ：工具跑起来、模型还没说话 → 「…」卡出现 → 喊停 → 卡只去按钮，不撤回、没有网关回执
//   steer ：任务中途插话 → 整个过程只有一张回答卡（同一个 cardKey），一直更新成最终回答
// 用法：PIBOT_DATA_DIR=... PIBOT_LOCAL_PORT=... node tests/card-e2e.mjs <stop|steer>
import { readFileSync, existsSync } from "node:fs";
const H = process.env.HOME, D = process.env.PIBOT_DATA_DIR || `${H}/pi-bot-cn-data`, BASE = `http://127.0.0.1:${process.env.PIBOT_LOCAL_PORT || 8787}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : []);
const gw = () => lines(`${D}/logs/gateway.jsonl`);
const send = (chatId, text) => fetch(`${BASE}/inbound`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId, text }) });
async function until(fn, ms, step = 300) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(step); } return null; }
const scen = process.argv[2], chat = `card-${scen}-${Date.now() % 100000}`, n0 = gw().length;
const ev = (name, after = 0) => gw().slice(n0).find((e) => e.event === name && e.chatId === chat && e.ms > after);
if (scen === "stop") {
	await send(chat, "直接运行 sleep 30（运行前什么都别说），跑完告诉我现在几点。");
	const ts = await until(() => ev("tool_start"), 90000);
	await sleep(3500);
	await send(chat, "停");
	await until(() => ev("agent_settled", ts?.ms ?? 0), 60000);
} else {
	await send(chat, "先用一句话说你要做什么，然后运行 sleep 25，跑完告诉我现在几点。");
	const ts = await until(() => ev("tool_start"), 90000);
	await sleep(4000);
	await send(chat, "另外顺便告诉我今天星期几");
	await until(() => gw().slice(n0).filter((e) => e.event === "agent_settled" && e.chatId === chat).length && !gw().slice(n0).some((e) => e.event === "agent_start" && e.chatId === chat && e.ms > (ev("agent_settled")?.ms ?? 0)) && ev("agent_settled"), 120000);
	await sleep(3000);
}
await sleep(1500);
const said = lines(`${D}/channel-local/${chat}.jsonl`);
console.log(JSON.stringify({
	scen,
	messages: said.map((m) => `[${m.purpose}${m.final ? " final" : ""}${m.cardKey ? " " + m.cardKey.split(":").pop() : ""}] ${String(m.text ?? "").slice(0, 120).replace(/\n/g, " ")}`),
	distinctCards: [...new Set(said.filter((m) => m.purpose === "card").map((m) => m.cardKey))].length,
	nonCard: said.filter((m) => m.purpose !== "card").length,
	suppressed: gw().slice(n0).filter((e) => e.event === "quiet_suppressed" && e.chatId === chat).map((e) => e.purpose),
}, null, 1));
