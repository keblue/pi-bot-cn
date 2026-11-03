#!/usr/bin/env node
// 浏览器场景端到端测试（本地通道 + 真模型）：发一句话 → 自动应对审批卡 / 验证码提问 / 插话 → 记录时间线和录屏位置。
// 用法：node tests/browser-e2e.mjs <名字> "<要说的话>" [--approve 可以|先别] [--code-file /tmp/otp-code.txt]
//        [--mode always] [--say "停" --after-tools 3] [--timeout 600]
// 环境：PIBOT_DATA_DIR / PIBOT_LOCAL_PORT 指向要测的实例。公众号「AI之境」
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
const H = process.env.HOME, D = process.env.PIBOT_DATA_DIR || `${H}/pi-bot-cn-data`, BASE = `http://127.0.0.1:${process.env.PIBOT_LOCAL_PORT || 8787}`;
const [name, text, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, "")] = rest[i + 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : []);
const send = (chatId, t) => fetch(`${BASE}/inbound`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId, text: t }) }).then((r) => r.json());
const chat = `br-${name}-${Date.now() % 100000}`;
const n0 = lines(`${D}/logs/gateway.jsonl`).length;
const t0 = Date.now();
const rel = (ms) => ((ms - t0) / 1000).toFixed(1) + "s";
const timeline = [];
const note = (s) => (timeline.push(`${rel(Date.now())} ${s}`), console.error(timeline.at(-1)));

if (opt.mode === "always") { await send(chat, "始终允许"); await sleep(500); }
if (opt["code-file"]) rmSync(opt["code-file"], { force: true });
let lastSent = Date.now();
await send(chat, text);
note(`主人：${text}`);
const seen = new Set();
let tools = 0, saidInterrupt = false, done = false, settledAt = 0;
const deadline = t0 + Number(opt.timeout || 600) * 1000;
while (Date.now() < deadline && !done) {
	await sleep(700);
	const ev = lines(`${D}/logs/gateway.jsonl`).slice(n0).filter((e) => e.chatId === chat);
	for (const e of ev) {
		const k = JSON.stringify(e);
		if (seen.has(k)) continue;
		seen.add(k);
		if (e.event === "tool_start") { tools++; note(`工具 ${e.tool}${e.cmd ? " " + e.cmd.slice(0, 80) : ""}`); }
		if (e.event === "tool_end" && e.isError) note(`  ↳ 出错 ${e.tool}`);
		if (e.event === "approval_request") {
			note(`审批卡：${e.why}｜${e.cmd}（kind=${e.kind ?? "-"} critical=${e.critical} 模式=${e.mode}）`);
			const ans = opt.approve || "可以";
			await sleep(2500);
			await send(chat, ans); lastSent = Date.now(); note(`主人：${ans}`);
		}
		if (e.event === "approval_decision") note(`审批结果：${e.state}（${e.how}，等了 ${(e.waitedMs / 1000).toFixed(1)}s）`);
		if (e.event === "input_request") {
			note(`机器人问主人要${e.secret ? "验证码（保密）" : "输入"}（${e.host ?? ""}）`);
			let code = opt.answer;
			if (!code && opt["code-file"]) for (let i = 0; i < 40 && !code; i++) { if (existsSync(opt["code-file"])) code = readFileSync(opt["code-file"], "utf8").trim(); else await sleep(500); }
			await sleep(2000);
			await send(chat, code || "好了"); lastSent = Date.now(); note(`主人：${e.secret ? "[验证码]" : code || "好了"}`);
		}
		if (e.event === "input_done") note(`验证码处理：${e.how}`);
		if (e.event === "browser_image_out" || e.event === "file_out") note(`发出${e.event === "file_out" ? "文件" : "截图"} ${e.path ?? ""}`);
		if (e.event === "agent_settled") { settledAt = e.ms ?? Date.now(); note(`一轮结束${e.aborted ? "（被打断）" : ""}`); }
	}
	if (opt.say && !saidInterrupt && tools >= Number(opt["after-tools"] || 3)) {
		saidInterrupt = true; await send(chat, opt.say); lastSent = Date.now(); note(`主人插话：${opt.say}`);
	}
	if (settledAt && settledAt > lastSent && Date.now() - settledAt > 4000) {
		const busy = lines(`${D}/logs/gateway.jsonl`).slice(n0).some((e) => e.chatId === chat && (e.ms ?? 0) > settledAt && e.event === "tool_start");
		if (!busy) done = true;
	}
}
await sleep(1500);
const bot = lines(`${D}/channel-local/${chat}.jsonl`).map((m) => `[${m.purpose ?? ""}${m.final ? " final" : ""}] ${m.purpose === "image" || m.purpose === "file" ? (m.path ?? m.image ?? "") + " " + (m.caption ?? m.text ?? "") : String(m.note ?? m.text ?? "").slice(0, 400)}`);
const recDir = join(D, "recordings");
const recs = existsSync(recDir) ? readdirSync(recDir).map((d) => join(recDir, d)).filter((d) => statSync(d).mtimeMs > t0) : [];
const out = { name, chat, ok: done, seconds: +((Date.now() - t0) / 1000).toFixed(1), tools, timeline, botSaid: bot, recordings: recs };
mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(new URL(`./out/browser-${name}.json`, import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
