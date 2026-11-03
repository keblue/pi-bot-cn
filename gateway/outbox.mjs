// Outbox：每条外发消息先落盘（JSONL 追加），按 chat 内 seq 严格保序投递；
// 投递成功再追加 done 记录。进程重启时重放文件，未 done 的续发。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cst } from "./util.mjs";

export class Outbox {
	constructor(file, { log, deliver }) {
		this.file = file;
		this.log = log;
		this.deliver = deliver; // async (msg) => void；抛错 = 稍后重试
		this.pending = new Map(); // chatId -> [msg...]（按 seq 排序）
		this.seqByChat = new Map();
		this.running = new Set();
		this.backoff = new Map();
		mkdirSync(dirname(file), { recursive: true });
		this._load();
	}

	_load() {
		if (!existsSync(this.file)) return;
		const enq = new Map();
		const done = new Set();
		for (const line of readFileSync(this.file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let r;
			try {
				r = JSON.parse(line);
			} catch {
				continue;
			}
			if (r.op === "enq") enq.set(r.msg.id, r.msg);
			else if (r.op === "done") done.add(r.id);
			else if (r.op === "seq") this.seqByChat.set(r.chatId, Math.max(this.seqByChat.get(r.chatId) ?? 0, r.seq));
		}
		for (const m of enq.values()) {
			this.seqByChat.set(m.chatId, Math.max(this.seqByChat.get(m.chatId) ?? 0, m.seq));
			if (done.has(m.id)) continue;
			if (!this.pending.has(m.chatId)) this.pending.set(m.chatId, []);
			this.pending.get(m.chatId).push(m);
		}
		for (const list of this.pending.values()) list.sort((a, b) => a.seq - b.seq);
		// 压缩：只保留未投递的 enq + 每个 chat 的最大 seq 水位
		const tmp = this.file + ".tmp";
		const lines = [];
		for (const [chatId, seq] of this.seqByChat) lines.push(JSON.stringify({ op: "seq", chatId, seq }));
		for (const list of this.pending.values()) for (const m of list) lines.push(JSON.stringify({ op: "enq", msg: m }));
		writeFileSync(tmp, lines.join("\n") + (lines.length ? "\n" : ""));
		renameSync(tmp, this.file);
		this.log("outbox_loaded", { pending: this.pendingCount() });
	}

	pendingCount() {
		let n = 0;
		for (const l of this.pending.values()) n += l.length;
		return n;
	}

	enqueue(chatId, purpose, text, extra = {}) {
		if (!text && !extra.final) return null;
		const seq = (this.seqByChat.get(chatId) ?? 0) + 1;
		this.seqByChat.set(chatId, seq);
		const msg = { id: `${chatId}#${seq}`, chatId, seq, purpose, text, createdAt: cst(), ...extra };
		appendFileSync(this.file, JSON.stringify({ op: "enq", msg }) + "\n");
		if (!this.pending.has(chatId)) this.pending.set(chatId, []);
		this.pending.get(chatId).push(msg);
		this.kick(chatId);
		return msg;
	}

	async drain(maxMs = 1500) {
		const t0 = Date.now();
		while (this.pendingCount() && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 50));
	}

	kickAll() {
		for (const chatId of this.pending.keys()) this.kick(chatId);
	}

	async kick(chatId) {
		if (this.running.has(chatId)) return;
		this.running.add(chatId);
		try {
			const list = this.pending.get(chatId) ?? [];
			while (list.length) {
				const msg = list[0];
				// 同一张卡片的更新是「全量快照」：后面还有更新的就跳过旧的（飞书 patch 限频 + 积压时省时间）
				if (msg.supersedeKey && list.slice(1).some((m) => m.supersedeKey === msg.supersedeKey)) {
					appendFileSync(this.file, JSON.stringify({ op: "done", id: msg.id, at: cst(), superseded: true }) + "\n");
					list.shift();
					continue;
				}
				try {
					await this.deliver(msg);
					appendFileSync(this.file, JSON.stringify({ op: "done", id: msg.id, at: cst() }) + "\n");
					list.shift();
					this.backoff.delete(chatId);
				} catch (e) {
					const b = Math.min((this.backoff.get(chatId) ?? 500) * 2, 30_000);
					this.backoff.set(chatId, b);
					this.log("outbox_retry", { chatId, id: msg.id, inMs: b, err: String(e?.message ?? e).slice(0, 120) });
					setTimeout(() => this.kick(chatId), b);
					return;
				}
			}
		} finally {
			this.running.delete(chatId);
		}
	}
}
