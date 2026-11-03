// 一个 chatId 对应一个常驻 `pi --mode rpc` 子进程。
// 严格 JSONL 分帧（只按 \n 切，不用 readline——见 pi docs/rpc.md）。
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export class RpcSession extends EventEmitter {
	constructor({ chatId, sessionId, piBin, args, cwd, env, log }) {
		super();
		Object.assign(this, { chatId, sessionId, piBin, args, cwd, env, log });
		this.pending = new Map();
		this.seq = 0;
		this.busy = false;
		this.alive = false;
		this.activeTools = new Map();
		this.textStreaming = false;
		this.lastActivity = Date.now();
	}

	start() {
		this.proc = spawn(this.piBin, this.args, { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
		this.alive = true;
		this.pid = this.proc.pid;
		let buf = Buffer.alloc(0);
		this.proc.stdout.on("data", (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			let i;
			while ((i = buf.indexOf(10)) >= 0) {
				let line = buf.subarray(0, i).toString("utf8");
				buf = buf.subarray(i + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line.trim()) continue;
				let rec;
				try {
					rec = JSON.parse(line);
				} catch {
					this.log("rpc_bad_line", { chatId: this.chatId, head: line.slice(0, 120) });
					continue;
				}
				this._onRecord(rec);
			}
		});
		this.proc.stderr.on("data", (d) => {
			const text = d.toString().trim();
			if (text) this.log("pi_stderr", { chatId: this.chatId, text: text.slice(0, 400) });
		});
		this.proc.stdin.on("error", () => {});
		this.proc.on("exit", (code, signal) => {
			this.alive = false;
			this.busy = false;
			for (const p of this.pending.values()) p.reject(new Error(`pi exited (${code ?? signal})`));
			this.pending.clear();
			this.emit("exit", { code, signal });
		});
		this.log("session_spawn", { chatId: this.chatId, sessionId: this.sessionId, pid: this.pid });
	}

	_onRecord(rec) {
		this.lastActivity = Date.now();
		if (rec.type === "response") {
			const p = rec.id && this.pending.get(rec.id);
			if (p) {
				this.pending.delete(rec.id);
				p.resolve(rec);
			}
			return;
		}
		if (rec.type === "extension_ui_request") {
			// 飞书卡片审批接上之前：对话框一律「取消」（= 拒绝），不让会话卡死
			if (["select", "confirm", "input", "editor"].includes(rec.method)) {
				this.write({ type: "extension_ui_response", id: rec.id, cancelled: true });
			}
			this.emit("ui", rec);
			return;
		}
		switch (rec.type) {
			case "agent_start":
				this.busy = true;
				break;
			case "agent_settled":
				this.busy = false;
				this.textStreaming = false;
				this.activeTools.clear();
				break;
			case "tool_execution_start":
				this.activeTools.set(rec.toolCallId, { name: rec.toolName, args: rec.args, startedAt: Date.now() });
				this.textStreaming = false;
				break;
			case "tool_execution_end":
				this.activeTools.delete(rec.toolCallId);
				break;
			case "message_update":
				if (rec.assistantMessageEvent?.type === "text_delta") this.textStreaming = true;
				break;
			case "message_end":
				this.textStreaming = false;
				break;
		}
		this.emit("event", rec);
	}

	write(obj) {
		if (!this.alive) throw new Error("session not alive");
		this.proc.stdin.write(JSON.stringify(obj) + "\n");
	}

	request(cmd, timeoutMs = 60_000) {
		const id = `g${++this.seq}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`rpc timeout: ${cmd.type}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (r) => (clearTimeout(timer), resolve(r)),
				reject: (e) => (clearTimeout(timer), reject(e)),
			});
			try {
				this.write({ ...cmd, id });
			} catch (e) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(e);
			}
		});
	}

	bashActive() {
		for (const t of this.activeTools.values()) if (t.name === "bash") return t;
		return null;
	}

	async stop(graceMs = 10_000) {
		if (!this.alive) return;
		const exited = new Promise((r) => this.once("exit", r));
		try {
			this.proc.stdin.end(); // 有序关闭：pi 会 dispose runtime（pi-memory 借此写退出小结）
		} catch {}
		const t = setTimeout(() => this.proc.kill("SIGTERM"), graceMs);
		await exited;
		clearTimeout(t);
	}
}
