// duet-gateway：pi-bot-cn 的常驻网关（公众号「AI之境」）
// 通道（local / feishu）→ Gate → 按 chatId 串行 → 常驻 pi RPC 会话 → 事件流 → Outbox → 通道
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
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

function say(chatId, purpose, text, extra = {}) {
	const channel = chats[chatId]?.channel ?? "local";
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
	};
	s = new RpcSession({ chatId, sessionId, piBin: cfg.piBin, args, cwd: cfg.workspace, env, log });
	s.on("event", (ev) => onEvent(chatId, s, ev));
	s.on("exit", (e) => {
		log("session_exit", { chatId, ...e });
		flushStream(chatId);
		if (chats[chatId]) (chats[chatId].running = false), saveChats();
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
			chats[chatId].running = true;
			saveChats();
			break;
		case "agent_settled":
			flushStream(chatId);
			chats[chatId].running = false;
			saveChats();
			log("agent_settled", { chatId, aborted: ev.aborted, sinceMarkMs: mark ? Date.now() - mark.t0 : undefined });
			break;
		case "tool_execution_start":
			flushStream(chatId);
			log("tool_start", { chatId, tool: ev.toolName, cmd: ev.toolName === "bash" ? String(ev.args?.command).slice(0, 200) : undefined });
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
				if (m.stopReason === "error" && !/abort/i.test(String(m.errorMessage ?? ""))) say(chatId, "attention", `⚠️ 模型出错：${String(m.errorMessage ?? "").slice(0, 200)}`);
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

// ---- 入站：Gate → 命令 → 意图 → RPC ----
const chains = new Map();
function handleInbound(msg) {
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
		say(chatId, "ack", `会话 ${chats[chatId].sessionId}｜${s?.alive ? (s.busy ? "正在干活" : "空闲") : "未启动"}｜待发 ${outbox.pendingCount()} 条`);
		return { intent: "status" };
	}
	if (t === "/new") {
		const sid = `chat-${safeId(chatId)}-${Date.now().toString(36)}`;
		const s = sessions.get(chatId);
		if (s?.alive) await s.stop();
		chats[chatId].sessionId = sid;
		saveChats();
		say(chatId, "ack", "好，开个新话题。（记忆还在）");
		return { intent: "new", sessionId: sid };
	}

	const s = getSession(chatId);
	const busy = s.busy;
	const intent = busy ? classify(policy, t) : t === "/abort" ? "noop" : "prompt";
	const t0 = receivedAt ?? Date.now();
	marks.set(chatId, { t0, kind: intent });
	log("intent", { chatId, intent, busy, bashActive: !!s.bashActive(), textStreaming: s.textStreaming });

	if (intent === "noop") return { intent };
	if (intent === "prompt") {
		s.busy = true;
		const r = await s.request({ type: "prompt", message: t });
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
		say(chatId, "attention", "⚠️ 我刚重启了一下，上一件事没做完被打断了。要我接着做吗？");
		c.running = false;
	}
}
saveChats();
for (const ch of channels.values()) ch.start();
outbox.kickAll();
log("gateway_start", { pid: process.pid, model: `${cfg.provider}/${cfg.model}`, channels: [...channels.keys()], outboxPending: outbox.pendingCount() });

let stopping = false;
async function shutdown(sig) {
	if (stopping) return;
	stopping = true;
	log("gateway_stop", { sig });
	for (const chatId of streamBuf.keys()) flushStream(chatId);
	for (const ch of channels.values()) ch.stop?.();
	await Promise.race([Promise.all([...sessions.values()].map((s) => s.stop(8000))), new Promise((r) => setTimeout(r, 12_000))]);
	process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
