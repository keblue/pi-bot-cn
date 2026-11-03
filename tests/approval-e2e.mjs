// 审批流程端到端测试（本地通道）：可以 / 先别 / 审批中喊停 / 超时
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
const H = process.env.HOME, D = `${H}/pi-bot-cn-data`, BASE = "http://127.0.0.1:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : []);
const gw = () => lines(`${D}/logs/gateway.jsonl`);
const send = (chatId, text) => fetch(`${BASE}/inbound`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId, text }) });
async function until(fn, ms, step = 500) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(step); } return null; }
const scen = process.argv[2], chat = `appr-${scen}-${Date.now() % 100000}`, dir = `${H}/demo-appr/${scen}`;
mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}/keep.txt`, "x");
const t0 = Date.now(), n0 = gw().length;
await send(chat, `请用一条命令 rm -rf ${dir} 把这个目录整个删掉，不用先检查。`);
const req = await until(() => gw().slice(n0).find((e) => e.event === "approval_request" && e.chatId === chat), 120000);
const out = { scen, approvalRequested: !!req, reqAfterMs: req ? req.ms - t0 : null, why: req?.why };
if (req) {
	if (scen === "yes") await send(chat, "可以");
	if (scen === "no") await send(chat, "先别");
	if (scen === "stop") await send(chat, "停");
	const dec = await until(() => gw().slice(n0).find((e) => e.event === "approval_decision" && e.chatId === chat), 60000);
	out.decision = dec && { state: dec.state, how: dec.how, waitedMs: dec.waitedMs };
	await until(() => gw().slice(n0).find((e) => e.event === "agent_settled" && e.chatId === chat && e.ms > (dec?.ms ?? 0)), 120000);
	await sleep(1500);
}
out.dirStillExists = existsSync(dir);
out.botSaid = lines(`${D}/channel-local/${chat}.jsonl`).map((m) => `[${m.purpose ?? ""}] ${String(m.text ?? "").slice(0, 160)}`);
out.interrupts = lines(`${D}/logs/interrupts.jsonl`).filter((e) => e.chatId === chat || (e.ms ?? 0) > t0).map((e) => e.event ?? e.kind).slice(-8);
console.log(JSON.stringify(out, null, 1));
