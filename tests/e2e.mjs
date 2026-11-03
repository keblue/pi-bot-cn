// pi-bot-cn 真机实测（本地测试通道，真实 MiniMax 模型）。用法：node tests/e2e.mjs <memory|steer|interrupt|restart|all>
// 只读日志与投递文件，不读、不打印任何密钥。
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const DATA = process.env.PIBOT_DATA_DIR ?? `${process.env.HOME}/pi-bot-cn-data`;
const BASE = `http://127.0.0.1:${process.env.PIBOT_LOCAL_PORT ?? 8787}`;
const GW = join(DATA, "logs/gateway.jsonl");
const INT = join(DATA, "logs/interrupts.jsonl");
const OUT = process.env.TEST_OUT ?? join(process.cwd(), "tests/out");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cst = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().replace("T", " ").replace("Z", "+08:00");
let report = [];
const note = (s) => {
	const line = `[${cst()}] ${s}`;
	console.log(line);
	report.push(line);
};
const readJsonl = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const gwSince = (t0) => readJsonl(GW).filter((e) => (e.ms ?? 0) >= t0);
const delivered = (chatId, t0) => readJsonl(join(DATA, "channel-local", `${chatId}.jsonl`)).filter((m) => Date.parse(m.deliveredAt.replace(" ", "T")) >= t0 - 1000);
async function post(path, body) {
	const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
	return r.json().catch(() => ({}));
}
async function send(chatId, text) {
	note(`→ [${chatId}] ${text}`);
	return post("/inbound", { chatId, text });
}
async function waitFor(pred, timeout, label) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const v = pred();
		if (v) return v;
		await sleep(50);
	}
	throw new Error(`timeout waiting: ${label}`);
}
const waitEvent = (t0, chatId, ev, timeout = 180000, extra = () => true) =>
	waitFor(() => gwSince(t0).find((e) => e.event === ev && (!chatId || e.chatId === chatId) && extra(e)), timeout, ev);
function botText(chatId, t0) {
	return delivered(chatId, t0).map((m) => `${m.purpose}#${m.seq}: ${m.text}`).join("\n");
}
async function restartGateway() {
	const t0 = Date.now();
	execSync("sudo systemctl restart pi-bot-cn");
	const h = await waitFor(() => { try { const j = JSON.parse(execSync(`curl -fsS -m 2 ${BASE}/health`, { stdio: ["ignore", "pipe", "ignore"] }).toString()); return j.ok && j; } catch { return null; } }, 30000, "health");
	let ws = null;
	try { ws = await waitEvent(t0, null, "FEISHU_WS_CONNECTED", 20000); } catch {}
	note(`重启完成：health OK ${Date.now() - t0}ms，pid=${h.pid}；FEISHU_WS ${ws ? `重新 connected @ ${ws.t}（重启后 ${ws.ms - t0}ms）` : "未见 connected（飞书未启用或连接失败）"}`);
	return h;
}
function save(name, extra) {
	const f = join(OUT, `${name}.log`);
	writeFileSync(f, report.join("\n") + "\n" + (extra ? `\n${extra}\n` : ""));
	report = [];
	console.log(`saved ${f}`);
}
function pgrepPoll(pattern) {
	// 每 20ms 查一次进程是否还在，返回 stop() → 最后一次看到的时间 / 消失时间
	let goneAt = null, lastSeen = null, seenEver = false, timer;
	const tick = () => {
		let alive = false;
		try { execSync(`pgrep -f -x '${pattern}'`, { stdio: "ignore" }); alive = true; } catch {}
		const now = Date.now();
		if (alive) { seenEver = true; lastSeen = now; goneAt = null; } else if (seenEver && !goneAt) goneAt = now;
		timer = setTimeout(tick, 20);
	};
	tick();
	return { state: () => ({ seenEver, lastSeen, goneAt }), stop: () => clearTimeout(timer) };
}

// ---------- 1. 记忆跨重启 ----------
async function testMemory() {
	const tag = Date.now().toString(36);
	const A = `mem-a-${tag}`, B = `mem-b-${tag}`;
	note("【测试1 记忆跨重启】在会话 A 说出长期偏好 → 重启网关 → 全新会话 B 提问，看是否自然用上且不复述记忆");
	let t0 = Date.now();
	await send(A, "记一下我的长期偏好：以后叫我「老蛇」，回答尽量用三条要点，结尾加一句「—— AI之境」。我最喜欢的编程语言是 Rust。");
	await waitEvent(t0, A, "agent_settled");
	await sleep(1500);
	note(`A 的回复：\n${botText(A, t0)}`);
	const mem = execSync(`grep -rl "老蛇" ${DATA}/memory 2>/dev/null || true`).toString().trim();
	note(`记忆目录里含「老蛇」的文件：${mem || "（无）"}`);
	await restartGateway();
	t0 = Date.now();
	await send(B, "推荐一门适合写命令行工具的编程语言，简短说说理由。");
	const st = await waitEvent(t0, B, "agent_settled");
	await sleep(1500);
	const txt = botText(B, t0);
	note(`B 的回复（${st.sinceMarkMs}ms）：\n${txt}`);
	const checks = { 称呼老蛇: /老蛇/.test(txt), 提到Rust: /Rust/i.test(txt), 署名: /AI之境/.test(txt), 没复述记忆: !/根据(我的)?记忆|我记得你|你之前(说|告诉)/.test(txt) };
	note(`检查：${JSON.stringify(checks)}`);
	const pass = checks.称呼老蛇 && checks.没复述记忆 && (checks.提到Rust || checks.署名);
	note(`结果：${pass ? "PASS" : "FAIL"}`);
	save(`01-memory-${tag}`);
	return pass;
}

// ---------- 2. steer 中途改道 ----------
async function testSteer() {
	const tag = Date.now().toString(36);
	const C = `steer-${tag}`;
	note("【测试2 steer 改道】多步任务进行中补一句新要求（普通补充 → steer），看模型是否在不停下的情况下采纳");
	const t0 = Date.now();
	await send(C, "在当前目录建 steer-test 文件夹，依次用 bash 创建 a.txt、b.txt、c.txt 三个文件（每个文件一条单独的命令，每条命令前先 sleep 3），内容都是 hello。做完列出目录。");
	await waitEvent(t0, C, "tool_start", 120000);
	const tS = Date.now();
	await send(C, "另外每个文件内容改成「你好 AI之境」，并且再多建一个 d.txt。");
	const steerIntent = await waitEvent(tS, C, "intent");
	const st = await waitEvent(tS, C, "agent_settled", 240000);
	await sleep(1500);
	note(`插话判定：intent=${steerIntent.intent}（busy=${steerIntent.busy}）；插话到收尾 ${st.ms - tS}ms`);
	const evs = gwSince(t0).filter((e) => e.chatId === C);
	note(`工具调用：\n${evs.filter((e) => e.event === "tool_start").map((e) => `  ${e.t} ${e.cmd}`).join("\n")}`);
	note(`queue_update：${JSON.stringify(evs.filter((e) => e.event === "queue_update").map((e) => [e.steering, e.followUp]))}`);
	const dir = `${DATA}/workspace/steer-test`;
	const ls = execSync(`ls ${dir} 2>/dev/null; for f in ${dir}/*.txt; do echo "$f: $(cat $f)"; done 2>/dev/null || true`).toString();
	note(`现场：\n${ls}`);
	note(`bot 输出：\n${botText(C, t0)}`);
	const hasD = /d\.txt/.test(ls);
	const newContent = (ls.match(/你好 AI之境/g) ?? []).length;
	const pass = steerIntent.intent === "steer" && hasD && newContent >= 2 && !evs.some((e) => e.event === "agent_settled" && e.aborted);
	note(`检查：intent=steer ${steerIntent.intent === "steer"}，d.txt ${hasD}，新内容文件数 ${newContent}，未中止 ${!evs.some((e) => e.event === "agent_settled" && e.aborted)}`);
	note(`结果：${pass ? "PASS" : "FAIL"}`);
	execSync(`rm -rf ${dir}`);
	save(`02-steer-${tag}`);
	return pass;
}

// ---------- 3. sleep 120 硬打断（停 / 改成…） ----------
async function hardCase(kind) {
	const tag = Date.now().toString(36);
	const C = `int-${kind}-${tag}`;
	const secs = 120;
	const t0 = Date.now();
	await send(C, `用 bash 执行 sleep ${secs}（就这一条命令，不要加别的，也不要后台运行），执行完告诉我“睡醒了”。`);
	await waitEvent(t0, C, "tool_start", 120000, (e) => /sleep/.test(e.cmd ?? ""));
	const poll = pgrepPoll(`sleep ${secs}`);
	await waitFor(() => poll.state().seenEver, 5000, "sleep process visible");
	await sleep(3000);
	const msg = kind === "stop" ? "停" : "改成：别睡了，直接用 bash 跑 date 告诉我现在几点";
	const tI = Date.now();
	const r = await send(C, msg);
	const toolEnd = await waitEvent(tI, C, "tool_end", 30000);
	await waitFor(() => poll.state().goneAt, 10000, "sleep gone").catch(() => null);
	poll.stop();
	const settled = await waitEvent(tI, C, "agent_settled", 120000);
	await sleep(1500);
	const p = poll.state();
	const ints = readJsonl(INT).filter((e) => e.chatId === C && Date.parse(e.ts ?? 0) >= tI - 50);
	const killed = ints.find((e) => e.event === "bash_killed");
	if (killed && killed.killMs == null) killed.killMs = Date.parse(killed.ts) - tI; // abort 路径：从收到「停」到扩展确认进程组被杀
	const firstText = gwSince(tI).find((e) => e.event === "first_text_after_mark" && e.chatId === C);
	const cancel = gwSince(tI).find((e) => e.event === "cancel_done" && e.chatId === C);
	const redirect = gwSince(tI).find((e) => e.event === "redirect_hard" && e.chatId === C);
	const intent = gwSince(tI).find((e) => e.event === "intent" && e.chatId === C);
	const res = {
		kind,
		intent: intent?.intent,
		bashActiveAtIntent: intent?.bashActive,
		processGoneMs: p.goneAt ? p.goneAt - tI : null,
		toolEndMs: toolEnd.ms - tI,
		toolInterruptedFlag: toolEnd.interrupted,
		killMsByExtension: killed?.killMs ?? null,
		killCause: killed?.cause ?? null,
		cancelIdleMs: cancel?.idleMs ?? null,
		redirectSentMs: redirect?.sentMs ?? null,
		firstTextAfterMs: firstText?.latencyMs ?? null,
		settledMs: settled.ms - tI,
		settledAborted: settled.aborted,
		leftoverSleep: (() => { try { execSync(`pgrep -f -x 'sleep ${secs}'`, { stdio: "ignore" }); return true; } catch { return false; } })(),
	};
	note(`[${kind}] 打断数据：${JSON.stringify(res)}`);
	note(`[${kind}] bot 输出：\n${botText(C, t0)}`);
	if (kind === "redirect") {
		const evs = gwSince(tI).filter((e) => e.chatId === C && e.event === "tool_start");
		note(`[${kind}] 打断后工具：${evs.map((e) => e.cmd).join(" | ") || "（无）"}`);
		res.ranDate = evs.some((e) => /date/.test(e.cmd ?? ""));
	}
	res.pass = res.processGoneMs !== null && res.processGoneMs < 2000 && !res.leftoverSleep && (kind === "stop" ? res.intent === "cancel" : res.intent === "redirect" && res.ranDate);
	note(`[${kind}] 结果：${res.pass ? "PASS" : "FAIL"}（目标：进程组 < 2000ms 消失）`);
	return res;
}
async function testInterrupt() {
	const tag = Date.now().toString(36);
	note("【测试3 硬打断】sleep 120 运行中：a)「停」 b)「改成…」；用 20ms pgrep 轮询测进程真正消失的时间");
	const a = await hardCase("stop");
	const b = await hardCase("redirect");
	save(`03-interrupt-${tag}`);
	return a.pass && b.pass;
}

// ---------- 4. 重启恢复 + Outbox 补发 ----------
async function testRestart() {
	const tag = Date.now().toString(36);
	const R = `rst-${tag}`;
	note("【测试4 重启恢复】通道断开 → 发消息（回复进 Outbox 积压）→ 重启网关 → 通道恢复 → 补发且有序；同一会话上下文接得上");
	let t0 = Date.now();
	await send(R, "暗号是「青龙偃月」，记在这个对话里就行，不用写进长期记忆。回复“收到”即可。");
	await waitEvent(t0, R, "agent_settled");
	await sleep(1000);
	note(`第一轮回复：${botText(R, t0)}`);
	await post("/channel/down");
	note("本地通道已 DOWN（模拟飞书/网络不可达）");
	t0 = Date.now();
	await send(R, "先用 bash 跑一下 date，然后告诉我刚才的暗号是什么，分三行：第一行暗号，第二行“一”，第三行“二”。");
	await waitEvent(t0, R, "agent_settled");
	await sleep(1500);
	const h1 = JSON.parse(execSync(`curl -fsS ${BASE}/health`).toString());
	note(`通道 DOWN 期间：已投递 ${delivered(R, t0).length} 条，outboxPending=${h1.outboxPending}`);
	const pendingBefore = h1.outboxPending;
	const h2 = await restartGateway();
	note(`重启后 outboxPending=${h2.outboxPending}（应仍为 ${pendingBefore}，Outbox 已持久化）`);
	const tUp = Date.now();
	await post("/channel/up");
	note("本地通道 UP");
	await waitFor(() => JSON.parse(execSync(`curl -fsS ${BASE}/health`).toString()).outboxPending === 0, 30000, "outbox drained");
	const got = delivered(R, tUp);
	note(`补发 ${got.length} 条，用时 ${Date.now() - tUp}ms：\n${got.map((m) => `  seq=${m.seq} ${m.purpose}: ${m.text}`).join("\n")}`);
	const seqs = got.map((m) => m.seq);
	const ordered = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
	const txt = got.map((m) => m.text).join("");
	t0 = Date.now();
	await send(R, "暗号再说一遍，只回暗号。");
	await waitEvent(t0, R, "agent_settled");
	await sleep(1500);
	const after = botText(R, t0);
	note(`重启后同一会话追问：${after}`);
	const checks = { 积压条数: pendingBefore, 重启后仍积压: h2.outboxPending === pendingBefore, 有序: ordered, 补发含暗号: /青龙偃月/.test(txt), 重启后上下文接上: /青龙偃月/.test(after) };
	note(`检查：${JSON.stringify(checks)}`);
	const pass = pendingBefore >= 2 && checks.重启后仍积压 && ordered && checks.补发含暗号 && checks.重启后上下文接上;
	note(`结果：${pass ? "PASS" : "FAIL"}`);
	save(`04-restart-outbox-${tag}`);
	return pass;
}

const which = process.argv[2] ?? "all";
const tests = { memory: testMemory, steer: testSteer, interrupt: testInterrupt, restart: testRestart };
const results = {};
for (const [k, fn] of Object.entries(tests)) {
	if (which !== "all" && which !== k) continue;
	try { results[k] = await fn(); } catch (e) { note(`${k} 出错：${e.message}`); save(`${k}-error-${Date.now().toString(36)}`); results[k] = false; }
}
console.log("RESULTS", JSON.stringify(results));
process.exit(0);
