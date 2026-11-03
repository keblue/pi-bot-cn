// duet-gateway：pi-bot-cn 的常驻网关（公众号「AI之境」）
// 通道（local / feishu）→ Gate → 按 chatId 串行 → 常驻 pi RPC 会话 → 事件流 → Outbox → 通道
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcSession } from "./rpc-session.mjs";
import { Outbox } from "./outbox.mjs";
import { classify, loadPolicy } from "./interrupt.mjs";
import { createLocalChannel } from "./channels/local.mjs";
import { createFeishuChannel } from "./channels/feishu.mjs";
import { cst, makeLogger, safeId } from "./util.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();
const DATA = process.env.PIBOT_DATA_DIR || join(HOME, "pi-bot-cn-data");
const cfg = {
	piBin: process.env.PIBOT_PI_BIN || join(HOME, ".npm-global/bin/pi"),
	provider: process.env.PIBOT_PROVIDER || "minimax-cn",
	model: process.env.PIBOT_MODEL || "MiniMax-M3.1-Flash",
	localPort: Number(process.env.PIBOT_LOCAL_PORT || 8787),
	workspace: process.env.PIBOT_WORKSPACE || join(DATA, "workspace"),
	memoryDir: process.env.PI_MEMORY_DIR || join(DATA, "memory"),
	sessionsDir: join(DATA, "sessions"),
	extension: join(REPO, "extensions/duet-core.ts"),
	persona: join(REPO, "prompts/persona.md"),
	policyFile: process.env.PIBOT_INTERRUPT_POLICY || join(REPO, "config/interrupt-policy.json"),
};
for (const d of [DATA, cfg.workspace, cfg.memoryDir, cfg.sessionsDir, join(DATA, "logs")]) mkdirSync(d, { recursive: true });

const log = makeLogger(join(DATA, "logs/gateway.jsonl"));
const policy = loadPolicy(readFileSync(cfg.policyFile, "utf8"));
const startedAt = Date.now();
let stopping = false;

// ---- chat 状态持久化（重启后知道每个 chat 用哪个 session、上次是否在跑）----
const chatsFile = join(DATA, "chats.json");
const chats = existsSync(chatsFile) ? JSON.parse(readFileSync(chatsFile, "utf8")) : {};
function saveChats() {
	writeFileSync(chatsFile + ".tmp", JSON.stringify(chats, null, 2));
	renameSync(chatsFile + ".tmp", chatsFile);
}

// ---- 通道 ----
const channels = new Map();
const local = createLocalChannel({ dataDir: DATA, port: cfg.localPort, log });
channels.set("local", local);
const feishu = await createFeishuChannel({ log, dataDir: DATA }).catch((e) => (log("feishu_init_error", { err: String(e?.message ?? e) }), null));
if (feishu) channels.set("feishu", feishu);

const outbox = new Outbox(join(DATA, "outbox/outbox.jsonl"), {
	log,
	deliver: async (msg) => {
		const ch = channels.get(msg.channel ?? "local");
		if (!ch) throw new Error(`no channel ${msg.channel}`);
		await ch.send(msg);
		log("outbox_delivered", { chatId: msg.chatId, seq: msg.seq, purpose: msg.purpose, chars: msg.text.length });
	},
});
local.onUp = () => outbox.kickAll();

// 安静通道（飞书）：网关自己拼的回执（「好，停了。已终止…」「收到，马上改」「🔧 正在执行：命令」）一律不发，只写日志；
// 聊天窗口里只有模型自己说的话 + 回答卡上的「停止」按钮 + 危险命令的审批卡。
const quiet = new Set(policy.quietChannels ?? []);
const isQuiet = (chatId) => quiet.has(chats[chatId]?.channel ?? "local");
function say(chatId, purpose, text, extra = {}) {
	const channel = chats[chatId]?.channel ?? "local";
	if (quiet.has(channel) && (purpose === "ack" || purpose === "progress")) {
		log("quiet_suppressed", { chatId, purpose, text: String(text).slice(0, 80) });
		return null;
	}
	if (purpose === "reply") purpose = "ack"; // 主人主动发的命令（/status /new）的回答：照常发
	if (purpose === "ack" && extra.replyTo === undefined && chats[chatId]?.lastMessageId) extra.replyTo = chats[chatId].lastMessageId;
	return outbox.enqueue(chatId, purpose, text, { channel, ...extra });
}

// ---- 会话管理 ----
const sessions = new Map();
const streamBuf = new Map(); // chatId -> {text, timer}

// 一条 assistant 消息 = 一个 streamKey（飞书据此把多段增量 patch 进同一张卡片）
const turnNo = new Map();
function streamKey(chatId) {
	return `${chatId}:${chats[chatId]?.sessionId}:${turnNo.get(chatId) ?? 0}:${startedAt}`;
}
function flushStream(chatId, { final = false } = {}) {
	const b = streamBuf.get(chatId);
	if (b) clearTimeout(b.timer), streamBuf.delete(chatId);
	const text = b?.text ?? "";
	const isFeishu = (chats[chatId]?.channel ?? "local") === "feishu";
	if (text.trim() || (final && isFeishu && b?.started !== false && turnHasText.get(chatId)))
		say(chatId, "stream", text, { streamKey: streamKey(chatId), final, replyTo: chats[chatId]?.lastMessageId ?? undefined });
	if (text.trim()) turnHasText.set(chatId, true);
	if (final) {
		turnNo.set(chatId, (turnNo.get(chatId) ?? 0) + 1);
		turnHasText.delete(chatId);
	}
}
const turnHasText = new Map();

// ---- 飞书回答卡：一次运行（agent_start→agent_settled）一张卡，只放模型说的话，原地 patch ----
// 运行开始就有卡（带「停止」按钮）：1.2s 内有文字就直接带文字发，否则先发「…」占位；
// 结束时去掉按钮；一个字都没说就结束（比如刚开始就被喊停）→ 撤回占位卡，保持安静。
// 主人插话改道后另起一张，让新回答出现在插话下面，像正常聊天。
const answer = new Map(); // chatId -> {key, text, timer, sentLen, needSep}
let answerSeg = 0;
function answerFor(chatId) {
	let a = answer.get(chatId);
	if (!a) answer.set(chatId, (a = { key: `${chatId}:${chats[chatId]?.sessionId}:${startedAt}:${++answerSeg}`, text: "", sentLen: 0, timer: null, needSep: false, placeholder: null }));
	return a;
}
function answerOpen(chatId) {
	if (!isQuiet(chatId)) return;
	const a = answerFor(chatId);
	if (a.sentLen || a.placeholder) return;
	a.placeholder = setTimeout(() => {
		if (answer.get(chatId) !== a || a.sentLen || a.text.trim()) return;
		say(chatId, "card", "…", { cardKey: a.key, final: false, supersedeKey: a.key });
		a.sentLen = -1; // 占位卡已发
	}, 1200);
}
function answerAppend(chatId, delta) {
	const a = answerFor(chatId);
	if (a.needSep && a.text.trim()) a.text += "\n\n";
	a.needSep = false;
	a.text += delta;
	if (!a.timer) a.timer = setTimeout(() => answerFlush(chatId), a.sentLen ? 700 : 400);
}
function answerFlush(chatId, { final = false } = {}) {
	const a = answer.get(chatId);
	if (!a) return;
	clearTimeout(a.timer);
	a.timer = null;
	const text = a.text.trim();
	if (text && (text.length !== a.sentLen || final)) {
		say(chatId, "card", text, { cardKey: a.key, final, supersedeKey: a.key });
		a.sentLen = text.length;
	} else if (!text && final && a.sentLen === -1) say(chatId, "card", "", { cardKey: a.key, final: true, supersedeKey: a.key }); // 撤回占位卡
	if (final) clearTimeout(a.placeholder), answer.delete(chatId);
}

function getSession(chatId) {
	let s = sessions.get(chatId);
	if (s?.alive) return s;
	chats[chatId] ??= { sessionId: `chat-${safeId(chatId)}`, createdAt: cst() };
	saveChats();
	const sessionId = chats[chatId].sessionId;
	const args = [
		"--mode", "rpc",
		"--provider", cfg.provider,
		"--model", cfg.model,
		"--session-dir", cfg.sessionsDir,
		"--session-id", sessionId,
		"-e", cfg.extension,
		"--append-system-prompt", cfg.persona,
	];
	const env = {
		...process.env,
		PI_MEMORY_DIR: cfg.memoryDir,
		PI_MEMORY_SNAPSHOT: process.env.PI_MEMORY_SNAPSHOT || "stable",
		PI_MEMORY_NO_SEARCH: process.env.PI_MEMORY_NO_SEARCH || "1",
		PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS: process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS || "8000",
		PIBOT_DATA_DIR: DATA,
		PIBOT_CHAT_ID: chatId,
		PIBOT_INTERRUPT_POLICY: cfg.policyFile,
	};
	s = new RpcSession({ chatId, sessionId, piBin: cfg.piBin, args, cwd: cfg.workspace, env, log });
	s.on("event", (ev) => onEvent(chatId, s, ev));
	s.on("approval", (rec) => onApprovalRequest(chatId, s, rec));
	s.on("exit", (e) => {
		log("session_exit", { chatId, ...e });
		flushStream(chatId);
		answerFlush(chatId, { final: true });
		for (const a of approvals.values()) if (a.chatId === chatId) decideApproval(a.id, false, "cancelled");
		if (chats[chatId] && !stopping) (chats[chatId].running = false), saveChats(); // 网关关停时保留 running，新进程据此知道有活没干完
	});
	s.start();
	sessions.set(chatId, s);
	return s;
}

const marks = new Map(); // chatId -> 打断计时 {t0, kind}

function onEvent(chatId, s, ev) {
	const channel = channels.get(chats[chatId]?.channel ?? "local");
	const mark = marks.get(chatId);
	switch (ev.type) {
		case "agent_start":
			answerOpen(chatId);
			chats[chatId].running = true;
			saveChats();
			break;
		case "agent_settled":
			flushStream(chatId);
			answerFlush(chatId, { final: true });
			chats[chatId].running = false;
			saveChats();
			log("agent_settled", { chatId, aborted: ev.aborted, sinceMarkMs: mark ? Date.now() - mark.t0 : undefined });
			break;
		case "tool_execution_start":
			flushStream(chatId);
			log("tool_start", { chatId, tool: ev.toolName, cmd: ev.toolName === "bash" ? String(ev.args?.command).slice(0, 200) : undefined });
			if (answer.has(chatId)) answerFlush(chatId); // 工具开跑前把已有文字推出去
			if (policy.showToolProgress && ev.toolName === "bash")
				say(chatId, "progress", `🔧 正在执行：${String(ev.args?.command ?? "").split("\n")[0].slice(0, 120)}`);
			break;
		case "tool_execution_end": {
			const text = ev.result?.content?.map((c) => c.text ?? "").join("") ?? "";
			const interrupted = /\[被用户打断\]/.test(text) || /Command aborted/.test(text);
			log("tool_end", {
				chatId,
				tool: ev.toolName,
				isError: ev.isError,
				durationMs: ev.durationMs,
				interrupted,
				sinceMarkMs: mark ? Date.now() - mark.t0 : undefined,
			});
			break;
		}
		case "message_update": {
			const a = ev.assistantMessageEvent;
			if (a?.type !== "text_delta") break;
			if (mark && !mark.firstDelta) {
				mark.firstDelta = Date.now();
				log("first_text_after_mark", { chatId, kind: mark.kind, latencyMs: mark.firstDelta - mark.t0 });
			}
			if (isQuiet(chatId)) {
				answerAppend(chatId, a.delta);
				break;
			}
			let b = streamBuf.get(chatId);
			if (!b) streamBuf.set(chatId, (b = { text: "" }));
			b.text += a.delta;
			if (channel?.streaming) {
				clearTimeout(b.timer);
				if (b.text.length >= 400) flushStream(chatId);
				else b.timer = setTimeout(() => flushStream(chatId), 1200);
			}
			break;
		}
		case "message_end": {
			const m = ev.message;
			if (m?.role === "assistant") {
				flushStream(chatId, { final: true });
				if (answer.has(chatId)) answer.get(chatId).needSep = true;
				if (m.stopReason === "error" && !/abort/i.test(String(m.errorMessage ?? "")))
					say(chatId, "attention", (policy.acks?.error ?? "哎，刚才出了点问题没弄完（{err}）。要我再试一次吗？").replace("{err}", String(m.errorMessage ?? "").slice(0, 120)));
			}
			break;
		}
		case "queue_update":
			log("queue_update", { chatId, steering: ev.steering?.length ?? 0, followUp: ev.followUp?.length ?? 0 });
			break;
		case "auto_retry_start":
			log("auto_retry", { chatId, attempt: ev.attempt, err: String(ev.errorMessage).slice(0, 120) });
			break;
	}
}

// ---- 危险命令审批（Grok Bot 式 approval）----
// duet-core 在执行危险命令前发 confirm(title=pibot-approval)；这里变成「可以，执行 / 先别」卡片。
// 决定方式：点按钮 / 直接回「可以」「先别」/ 超时（=不做）/ 喊停或插话（=取消）。
const approvals = new Map(); // id -> {id, chatId, session, command, why, timeoutMs, createdAt, timer}
const approvalTimeoutMs = (policy.approval?.timeoutMinutes ?? 10) * 60_000;
const reList = (arr) => (arr ?? []).map((x) => new RegExp(x, "i"));
const approveRe = reList(policy.approval?.approvePatterns);
const denyRe = reList(policy.approval?.denyPatterns);

function onApprovalRequest(chatId, s, rec) {
	let req = {};
	try {
		req = JSON.parse(rec.message ?? "{}");
	} catch {}
	const a = { id: rec.id, chatId, session: s, command: req.command ?? "", why: req.why ?? "", timeoutMs: req.timeoutMs ?? approvalTimeoutMs, createdAt: Date.now() };
	a.timer = setTimeout(() => decideApproval(a.id, false, "timeout"), a.timeoutMs);
	approvals.set(a.id, a);
	log("approval_request", { chatId, id: a.id, why: a.why, cmd: String(a.command).slice(0, 200) });
	// 先把之前的话收尾，审批卡出现在它下面；如果当前只有「…」占位卡，就直接把占位卡改成审批卡（不撤回、不多一条）
	let reuseCardKey;
	const cur = answer.get(chatId);
	if (cur && !cur.text.trim()) {
		clearTimeout(cur.placeholder);
		clearTimeout(cur.timer);
		if (cur.sentLen === -1) reuseCardKey = cur.key;
		answer.delete(chatId);
	} else answerFlush(chatId, { final: true });
	if ((chats[chatId]?.channel ?? "local") === "feishu")
		say(chatId, "approval", a.command, { approvalId: a.id, command: a.command, why: a.why, timeoutMs: a.timeoutMs, state: "pending", reuseCardKey });
	else say(chatId, "attention", `接下来这条命令${a.why}，你同意我执行吗？\n${a.command}\n（回「可以」或「先别」）`, { approvalId: a.id });
}

function decideApproval(id, approved, how, { tellPi = true } = {}) {
	const a = approvals.get(id);
	if (!a) return false;
	approvals.delete(id);
	clearTimeout(a.timer);
	// 喊停/插话时不回 pi：紧接着的 abort / pibot-interrupt 会让对话框自己结束，工具按「被打断」收尾
	try {
		if (tellPi && a.session.alive) a.session.write({ type: "extension_ui_response", id, confirmed: !!approved });
	} catch {}
	const state = approved ? "approved" : how === "timeout" ? "timeout" : how === "cancelled" ? "cancelled" : "denied";
	log("approval_decision", { chatId: a.chatId, id, state, how, waitedMs: Date.now() - a.createdAt });
	if ((chats[a.chatId]?.channel ?? "local") === "feishu")
		say(a.chatId, "approval", a.command, { approvalId: id, command: a.command, why: a.why, timeoutMs: a.timeoutMs, state });
	if (state !== "cancelled" && chats[a.chatId]?.running) answerOpen(a.chatId); // 接着干活：新回答卡（带停止）出现在审批卡下面
	return true;
}
const pendingApprovalOf = (chatId) => [...approvals.values()].filter((a) => a.chatId === chatId);

// ---- 入站：Gate → 命令 → 意图 → RPC ----
const chains = new Map();
const lateInbox = join(DATA, "outbox/late-inbound.jsonl"); // 关停期间收到的消息：落盘，新进程接着处理
function handleInbound(msg) {
	if (stopping) {
		appendFileSync(lateInbox, JSON.stringify(msg) + "\n");
		log("inbound_deferred", { chatId: msg.chatId, channel: msg.channel });
		return Promise.resolve({ deferred: true });
	}
	const prev = chains.get(msg.chatId) ?? Promise.resolve();
	let result;
	const p = prev.then(async () => (result = await processInbound(msg))).catch((e) => {
		log("inbound_error", { chatId: msg.chatId, err: String(e?.stack ?? e).slice(0, 400) });
		result = { error: String(e?.message ?? e) };
	});
	chains.set(msg.chatId, p);
	return p.then(() => result);
}

async function processInbound({ channel, chatId, text, receivedAt, messageId }) {
	chats[chatId] ??= { sessionId: `chat-${safeId(chatId)}`, createdAt: cst() };
	chats[chatId].channel = channel;
	if (messageId) chats[chatId].lastMessageId = messageId;
	const t = text.trim();
	log("inbound", { chatId, channel, chars: t.length, text: t.slice(0, 200) });

	if (t === "/status") {
		const s = sessions.get(chatId);
		say(chatId, "reply", `会话 ${chats[chatId].sessionId}｜${s?.alive ? (s.busy ? "正在干活" : "空闲") : "未启动"}｜待发 ${outbox.pendingCount()} 条`);
		return { intent: "status" };
	}
	if (t === "/new") {
		const sid = `chat-${safeId(chatId)}-${Date.now().toString(36)}`;
		const s = sessions.get(chatId);
		if (s?.alive) await s.stop();
		chats[chatId].sessionId = sid;
		saveChats();
		say(chatId, "reply", "好，换个话题。之前的事我都还记得。");
		return { intent: "new", sessionId: sid };
	}

	// 审批进行中：直接回「可以 / 先别」也算数；喊停 → 取消审批并停下；别的话 → 当作不同意，再按插话处理
	const pend = pendingApprovalOf(chatId);
	if (pend.length) {
		if (approveRe.some((r) => r.test(t))) {
			for (const a of pend) decideApproval(a.id, true, "text");
			return { intent: "approve" };
		}
		if (denyRe.some((r) => r.test(t))) {
			for (const a of pend) decideApproval(a.id, false, "text");
			return { intent: "deny" };
		}
		const k = classify(policy, t);
		const interrupting = k === "cancel" || k === "redirect";
		for (const a of pend) decideApproval(a.id, false, "cancelled", { tellPi: !interrupting });
	}

	const s = getSession(chatId);
	const busy = s.busy;
	if (busy && answer.has(chatId)) {
		answerFlush(chatId, { final: true }); // 插话：之前的回答收尾，新回答另起一张
		answerOpen(chatId);
	}
	const intent = busy ? classify(policy, t) : t === "/abort" ? "noop" : "prompt";
	const t0 = receivedAt ?? Date.now();
	marks.set(chatId, { t0, kind: intent });
	log("intent", { chatId, intent, busy, bashActive: !!s.bashActive(), textStreaming: s.textStreaming });

	if (intent === "noop") return { intent };
	if (intent === "prompt") {
		s.busy = true;
		let msg = t;
		if (chats[chatId]?.cutByRestart) {
			delete chats[chatId].cutByRestart;
			saveChats();
			msg = `[网关备注，不是主人说的：上一轮任务做到一半时我重启了，那件事没做完。如果和这句话有关，或者主人可能还在等结果，就用一句自然的话顺口提一下并问要不要接着做；不相关就别提。]\n\n${t}`;
			log("restart_note_injected", { chatId });
		}
		const r = await s.request({ type: "prompt", message: msg });
		if (!r.success) {
			s.busy = false;
			say(chatId, "attention", `⚠️ 没接上：${r.error}`);
		}
		return { intent, disposition: r.data?.disposition };
	}
	if (intent === "cancel") {
		const bash = s.bashActive();
		const q = await s.request({ type: "clear_queue" });
		const tSent = Date.now();
		await s.request({ type: "abort" }, 30_000);
		const tIdle = Date.now();
		log("cancel_done", { chatId, abortSentMs: tSent - t0, idleMs: tIdle - t0, killedCmd: bash ? String(bash.args?.command).slice(0, 200) : null, dropped: q.data });
		let ack = policy.acks?.cancel ?? "好，停了。";
		if (bash) ack += `\n已终止：\`${String(bash.args?.command).split("\n")[0].slice(0, 100)}\`（可能只做了一半）`;
		say(chatId, "ack", ack);
		return { intent, idleMs: tIdle - t0 };
	}
	if (intent === "redirect") {
		const bash = s.bashActive();
		say(chatId, "ack", policy.acks?.redirect ?? "收到，马上改。");
		if (bash && policy.hardInterruptOnRedirect !== false) {
			// 先把新指令排进 steering 队列，再立即杀掉当前工具：工具一结束模型就看到新指令
			await s.request({ type: "steer", message: t });
			await s.request({ type: "prompt", message: `/pibot-interrupt ${t}` });
			log("redirect_hard", { chatId, sentMs: Date.now() - t0 });
			return { intent, mode: "steer+interrupt" };
		}
		if (policy.redirectWhileThinking === "abort_and_prompt") {
			await s.request({ type: "clear_queue" });
			await s.request({ type: "abort" }, 30_000);
			s.busy = true;
			await s.request({ type: "prompt", message: t });
			log("redirect_abort_prompt", { chatId, sentMs: Date.now() - t0 });
			return { intent, mode: "abort+prompt" };
		}
		await s.request({ type: "steer", message: t });
		return { intent, mode: "steer" };
	}
	if (intent === "followUp") {
		await s.request({ type: "follow_up", message: t });
		say(chatId, "ack", policy.acks?.followUp ?? "好，这个做完就接着弄。");
		return { intent };
	}
	// 默认：普通补充 → steer（像真人插话）
	await s.request({ type: "steer", message: t });
	if (policy.acks?.steer) say(chatId, "ack", policy.acks.steer);
	return { intent: "steer" };
}

for (const ch of channels.values()) ch.onInbound(handleInbound);
feishu?.onCardAction(({ chatId, value }) => {
	if (value?.pibot === "approval") {
		const okd = decideApproval(value.id, !!value.ok, "card");
		if (!okd) log("approval_stale_click", { chatId, id: value.id });
		return {};
	}
	return {};
});

// ---- 健康检查 ----
local.setHealth(() => {
	const list = [...sessions.values()].map((s) => ({ chatId: s.chatId, pid: s.pid, alive: s.alive, busy: s.busy, tools: s.activeTools.size }));
	return {
		ok: true,
		pid: process.pid,
		startedAt: cst(startedAt),
		uptimeSec: Math.round((Date.now() - startedAt) / 1000),
		model: `${cfg.provider}/${cfg.model}`,
		channels: [...channels.keys()],
		sessions: list,
		outboxPending: outbox.pendingCount(),
		memoryDir: existsSync(cfg.memoryDir),
		feishu: feishu ? feishu.status() : { state: "disabled" },
	};
});

// ---- 空闲回收 ----
const idleMs = (policy.idleTimeoutMinutes ?? 30) * 60_000;
setInterval(() => {
	for (const s of sessions.values()) {
		if (s.alive && !s.busy && Date.now() - s.lastActivity > idleMs) {
			log("session_idle_reap", { chatId: s.chatId });
			s.stop();
		}
	}
}, 60_000).unref();

// ---- 启动：重启前没跑完的任务给主人一个交代 ----
for (const [chatId, c] of Object.entries(chats)) {
	if (c.running) {
		// 飞书：网关模板不发（只记日志）；改成在主人下一句话前给模型一个提示，让模型自己自然地提
		say(chatId, (c.channel ?? "local") === "feishu" ? "ack" : "attention", policy.acks?.restart ?? "刚才我重启了一下，你让我做的那件事没做完。要我接着做吗？");
		c.running = false;
		c.cutByRestart = true;
	}
}
saveChats();
for (const ch of channels.values()) ch.start();
outbox.kickAll();
// 上个进程关停期间收到的消息：按原顺序补处理
if (existsSync(lateInbox)) {
	const lines = readFileSync(lateInbox, "utf8").split("\n").filter(Boolean);
	rmSync(lateInbox, { force: true });
	for (const l of lines) {
		try {
			const m = JSON.parse(l);
			log("inbound_replay", { chatId: m.chatId, channel: m.channel, ageMs: Date.now() - (m.receivedAt ?? Date.now()) });
			handleInbound(m);
		} catch {}
	}
}
log("gateway_start", { pid: process.pid, model: `${cfg.provider}/${cfg.model}`, channels: [...channels.keys()], outboxPending: outbox.pendingCount() });

async function shutdown(sig) {
	if (stopping) return;
	stopping = true;
	log("gateway_stop", { sig });
	for (const chatId of streamBuf.keys()) flushStream(chatId);
	for (const chatId of [...answer.keys()]) answerFlush(chatId, { final: true });
	for (const a of [...approvals.values()]) decideApproval(a.id, false, "cancelled");
	// 先停 pi 会话（pi-memory 写退出小结要几秒），这段时间飞书长连接保持在线：
	// 期间收到的消息落盘到 late-inbound.jsonl，新进程起来后接着处理 → 飞书侧几乎感觉不到重启
	const t0 = Date.now();
	await Promise.race([Promise.all([...sessions.values()].map((s) => s.stop(8000))), new Promise((r) => setTimeout(r, 12_000))]);
	await Promise.race([outbox.drain?.() ?? Promise.resolve(), new Promise((r) => setTimeout(r, 1500))]);
	log("gateway_stop_sessions_done", { tookMs: Date.now() - t0 });
	for (const ch of channels.values()) ch.stop?.();
	setTimeout(() => process.exit(0), 50);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
