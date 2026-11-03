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
 * 3. 危险命令审批：执行前用 ctx.ui.confirm 发一个 RPC 对话框（title=pibot-approval），
 *    网关把它变成飞书「可以 / 先别」卡片；超时 = 不做；审批期间喊停/插话同样能立刻打断。
 *    规则在 config/interrupt-policy.json 的 approval 段。主人可选「始终允许」：普通危险命令由网关直接放行，
 *    但 alwaysAskRules（删整个系统、格式化磁盘、关机、改我自己的密钥…）带 critical:true，任何模式都问。
 * 4. 安全收尾：每次打断都写一行 interrupts.jsonl（命令、已运行时长、杀进程耗时、
 *    是否疑似破坏性），并在 tool 结果里提醒模型「可能半完成，先检查再继续」。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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

type Rule = { re: RegExp; why: string };
// rules：普通危险命令（「每次询问」模式下问；「始终允许」模式下网关直接放行）
// critical：灾难级命令（任何模式都问）——请求里带 critical:true，网关据此决定
type Approval = { enabled: boolean; timeoutMs: number; rules: Rule[]; critical: Rule[]; protectedPaths: RegExp[] };
function loadApproval(): Approval {
	const off: Approval = { enabled: false, timeoutMs: 600_000, rules: [], critical: [], protectedPaths: [] };
	try {
		const file = process.env.PIBOT_INTERRUPT_POLICY;
		if (!file) return off;
		const a = JSON.parse(readFileSync(file, "utf8")).approval ?? {};
		return {
			enabled: a.enabled !== false,
			timeoutMs: (a.timeoutMinutes ?? 10) * 60_000,
			rules: (a.rules ?? []).map((r: any) => ({ re: new RegExp(r.re, "i"), why: String(r.why) })),
			critical: (a.alwaysAskRules ?? []).map((r: any) => ({ re: new RegExp(r.re, "i"), why: String(r.why) })),
			protectedPaths: (a.protectedPathPatterns ?? []).map((x: string) => new RegExp(x, "i")),
		};
	} catch {
		return off;
	}
}

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
	const approval = loadApproval();

	/** 问主人；返回 true=同意。signal 被 abort（喊停/插话）时立即返回 false。 */
	async function ask(ctx: any, req: Record<string, unknown>, signal: AbortSignal | undefined) {
		if (!ctx?.hasUI || !ctx?.ui?.confirm) return false;
		const t0 = Date.now();
		// 网关自己掌握 10 分钟超时；这里多给 30s 兜底，防止网关丢了请求时会话卡死
		const ok = await ctx.ui.confirm("pibot-approval", JSON.stringify({ ...req, timeoutMs: approval.timeoutMs }), {
			timeout: approval.timeoutMs + 30_000,
			signal,
		});
		logLine({ event: "approval_result", ...req, approved: !!ok, aborted: !!signal?.aborted, waitedMs: Date.now() - t0 });
		return !!ok;
	}
	const denied = (what: string) => ({
		content: [
			{
				type: "text",
				text: `[没有得到同意] ${what} 没有执行（对方拒绝了，或者一直没回复）。不要换一种写法绕过，不要再次申请同一操作，也不要把命令贴出来让对方自己去跑。这一步的结果已经显示在审批卡上了，所以：要么什么都不说，要么只说**一句很短的话**（20 个字以内，用「你」称呼对方，别重复命令、别解释原因、别说「主人」「超时」「点了按钮」这类系统话）；如果任务还有不需要这一步的部分，就安静地继续做。`,
			},
		],
		details: { denied: true },
		isError: true,
	});

	// write / edit 碰到 .env、.ssh、密钥文件：同样先问
	pi.on("tool_call", async (event: any, ctx: any) => {
		if (!approval.enabled || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const path = String(event.input?.path ?? event.input?.file_path ?? "");
		// 写出来的脚本如果要直接连浏览器调试端口（绕开 browser_* 工具和付款审批），按灾难级处理
		const body = String(event.input?.content ?? event.input?.newText ?? event.input?.new_string ?? JSON.stringify(event.input?.edits ?? ""));
		const crit = approval.critical.find((r) => r.re.test(body) && /浏览器/.test(r.why));
		if (crit) {
			const ok = await ask(ctx, { tool: event.toolName, command: `${event.toolName} ${path}（脚本里要直接连浏览器）`, why: crit.why, critical: true }, ctx?.signal);
			if (!ok) return { block: true, reason: `没有得到同意，${path} 没有写。网页操作只能用 browser_* 工具，不要另写脚本连浏览器。` };
			return;
		}
		if (!approval.protectedPaths.some((r) => r.test(path))) return;
		const ok = await ask(ctx, { tool: event.toolName, command: `${event.toolName} ${path}`, why: "会改动密钥或配置文件", critical: true }, ctx?.signal);
		if (!ok) return { block: true, reason: `没有得到同意，${path} 没有改动。不要绕过，用一句自然的中文（用「你」称呼对方）说明这一步没做。` };
	});

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
				const crit = approval.enabled ? approval.critical.find((r) => r.re.test(entry.command)) : undefined;
				const hit = crit ?? (approval.enabled ? approval.rules.find((r) => r.re.test(entry.command)) : undefined);
				if (hit) {
					const ok = await ask(ctx, { tool: "bash", command: entry.command.slice(0, 600), why: hit.why, critical: !!crit }, ac.signal);
					if (ac.signal.aborted) throw new Error("aborted while waiting for approval");
					if (!ok) return denied(`命令 \`${entry.command.slice(0, 200)}\``) as any;
				}
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
					const partial = (err instanceof Error ? err.message : String(err)).replace(/\n*Command aborted\s*$/, "").replace(/^aborted while waiting for approval$/, "").trim();
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
						"不要重跑这条命令，除非用户明确要求；立刻按用户的最新指令继续。回复里不要说「收到」「已终止」之类的话，直接自然地给新结果（必要时顺口提一句半成品）。",
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
