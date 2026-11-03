/**
 * duet-core — pi-bot-cn 的「可硬打断」核心扩展（公众号「AI之境」）
 *
 * 做三件事：
 * 1. 用同名 registerTool 覆盖内置 bash（pi 官方支持的 tool override 方式），
 *    每个 bash 调用拿到一个自己的 AbortController，并与 pi 传进来的 signal 级联。
 *    pi 内置 bash 本身就是 detached 进程组 + killProcessTree(-pgid)，
 *    所以 abort 这个 controller = 立刻 SIGKILL 整个进程组（不是等命令自然结束）。
 * 2. 注册扩展命令 /pibot-interrupt <新指令>。RPC 模式下扩展命令即使在 streaming
 *    中也会「立即执行」，gateway 用它在毫秒级打断正在跑的工具调用。
 *    被打断的 bash 不会抛错终止整轮，而是返回一条 tool 结果：
 *    「[被用户打断] …新指令…」，模型拿到后立刻按新指令继续。
 * 3. 安全收尾：每次打断都写一行 interrupts.jsonl（命令、已运行时长、杀进程耗时、
 *    是否疑似破坏性），并在 tool 结果里提醒模型「可能半完成，先检查再继续」。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

type Active = {
	ac: AbortController;
	command: string;
	startedAt: number;
	interruptRequestedAt?: number;
};

type UserInterrupt = { kind: "user-interrupt"; message: string; requestedAt: number };

const DESTRUCTIVE =
	/\b(rm|mv|dd|mkfs|truncate|shred|chmod|chown|git\s+(push|reset|clean|checkout|rebase)|apt(-get)?|npm\s+(publish|install|i)|pip\s+install|systemctl|kill|curl\s+[^|]*-X\s*(POST|PUT|DELETE|PATCH))\b|>\s*[^&|]/;

function logLine(record: Record<string, unknown>) {
	const dataDir = process.env.PIBOT_DATA_DIR;
	if (!dataDir) return;
	const file = join(dataDir, "logs", "interrupts.jsonl");
	try {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), chatId: process.env.PIBOT_CHAT_ID, ...record }) + "\n");
	} catch {
		/* 日志失败不影响主流程 */
	}
}

export default function (pi: ExtensionAPI) {
	const active = new Map<string, Active>();
	const inner = createBashToolDefinition(process.cwd());

	pi.registerTool({
		...inner,
		name: "bash",
		label: "bash (interruptible)",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const ac = new AbortController();
			const onOuterAbort = () => ac.abort({ kind: "session-abort" });
			if (signal?.aborted) onOuterAbort();
			else signal?.addEventListener("abort", onOuterAbort, { once: true });
			const entry: Active = { ac, command: String(params.command ?? ""), startedAt: Date.now() };
			active.set(toolCallId, entry);
			try {
				return await inner.execute(toolCallId, params, ac.signal, onUpdate, ctx);
			} catch (err) {
				const reason = ac.signal.reason as UserInterrupt | { kind: string } | undefined;
				const now = Date.now();
				if (reason && reason.kind === "session-abort") {
					logLine({
						event: "bash_killed",
						cause: "abort",
						toolCallId,
						command: entry.command,
						ranMs: now - entry.startedAt,
						destructive: DESTRUCTIVE.test(entry.command),
					});
				}
				if (reason && reason.kind === "user-interrupt") {
					const r = reason as UserInterrupt;
					const partial = (err instanceof Error ? err.message : String(err)).replace(/\n*Command aborted\s*$/, "").trim();
					const destructive = DESTRUCTIVE.test(entry.command);
					logLine({
						event: "bash_killed",
						cause: "user-interrupt",
						toolCallId,
						command: entry.command,
						ranMs: now - entry.startedAt,
						killMs: now - r.requestedAt,
						destructive,
						newInstruction: r.message,
					});
					const text = [
						partial ? `（被打断前的输出）\n${partial}\n` : "",
						`[被用户打断] 这条命令运行了 ${((now - entry.startedAt) / 1000).toFixed(1)} 秒后，用户插话：「${r.message}」。`,
						`命令 \`${entry.command.slice(0, 300)}\` 的整个进程组已被终止（exit 130）。`,
						destructive
							? "⚠️ 这条命令可能有副作用（写文件/删除/安装/联网写操作），可能处于半完成状态：继续前先检查现场，必要时向用户说明。"
							: "它可能只完成了一部分。",
						"不要重跑这条命令，除非用户明确要求；立刻按用户的最新指令继续。",
					]
						.filter(Boolean)
						.join("\n");
					return {
						content: [{ type: "text", text }],
						details: { interrupted: true },
						structuredContent: {
							output: text,
							truncated: false,
							exit_code: 130,
							wall_time_seconds: Math.round((now - entry.startedAt) / 100) / 10,
						},
						isError: true,
					} as any;
				}
				throw err;
			} finally {
				active.delete(toolCallId);
				signal?.removeEventListener("abort", onOuterAbort);
			}
		},
	});

	pi.registerCommand("pibot-interrupt", {
		description: "立即打断正在运行的 bash（杀整个进程组），并把新指令作为工具结果交给模型",
		handler: async (args) => {
			const message = (args ?? "").trim() || "（用户要求打断）";
			const requestedAt = Date.now();
			const n = active.size;
			for (const entry of active.values()) {
				entry.interruptRequestedAt = requestedAt;
				entry.ac.abort({ kind: "user-interrupt", message, requestedAt } satisfies UserInterrupt);
			}
			logLine({ event: "interrupt_command", activeBash: n, message });
		},
	});
}
