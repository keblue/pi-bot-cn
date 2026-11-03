/**
 * browser — pi-bot-cn「自己的浏览器」扩展（公众号「AI之境」）
 *
 * 机器人在自己的服务器上开一个真 Chromium（Xvfb 虚拟屏幕 + 持久 profile，登录状态重启不丢），
 * 通过 127.0.0.1 上的 CDP 端口用 Playwright 操作网页。给模型的工具：
 *   browser_open / browser_snapshot / browser_click / browser_type / browser_press / browser_select /
 *   browser_scroll / browser_wait / browser_back / browser_screenshot / browser_download /
 *   browser_fill_secret / browser_list_secrets / browser_ask_owner / send_file
 *
 * 安全规则（写死在代码里，不靠模型自觉）：
 * - 付款 / 下单 / 提交订单这类按钮：点之前一定先截图、发「要付款了」审批卡（critical，始终允许模式也问）。
 * - 密码不经过模型：browser_fill_secret 按名字从 ~/.config/pi-bot-cn/vault.json（600）取值直接填，
 *   而且只填进密码库条目里登记的网站；快照里密码框、用密码库填过的框一律显示「已填，内容隐藏」。
 *   browser_type 不允许往密码框里打字。
 * - 验证码 / 短信码：browser_ask_owner 问主人；主人在聊天里回的码由网关截下直接填进网页，不交给模型、日志里打码。
 * - 喊停 / 改需求：每个浏览器动作都接 abort 信号，网关一 abort 立刻放手。
 * - 录屏：每次运行（agent_start→agent_end）用过浏览器就录一段 CDP screencast，结束时自动合成 GIF + 关键截图，
 *   放在 数据目录/recordings/<时间>/。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const HOME = homedir();
const DATA = process.env.PIBOT_DATA_DIR || join(HOME, "pi-bot-cn-data");
const CDP = `http://127.0.0.1:${process.env.PIBOT_BROWSER_CDP_PORT || 9223}`;
const VAULT = process.env.PIBOT_VAULT || join(HOME, ".config/pi-bot-cn/vault.json");
const DL_DIR = join(DATA, "browser/downloads");
const SNAP_JS = readFileSync(join(REPO, "browser/snapshot.js"), "utf8");
// 录像上限：每秒最多 5 帧，最多 1500 帧（≈5 分钟），超过就停录（避免一次任务录出几千帧）
const REC_MIN_GAP_MS = Number(process.env.PIBOT_REC_MIN_GAP_MS || 200);
const REC_MAX_FRAMES = Number(process.env.PIBOT_REC_MAX_FRAMES || 1500);
const MAX_SHOTS_PER_RUN = Number(process.env.PIBOT_BROWSER_MAX_SHOTS || 4);

// ---- 付款识别 ----
const PAY_STRONG =
	/(付款|支付(?!宝)|买单|提交订单|确认订单|立即下单|确认下单|去下单|立即购买|确认购买|确认付款|立即付款|马上付款|\bpay\b|pay now|place (your )?order|complete (your )?(order|purchase|payment)|confirm (order|purchase|payment)|buy now|submit (order|payment)|start trial|subscribe|purchase)/i;
// 「完成 / 确认 / 提交」这类词本身不一定是付款：只有在结算页、而且页面上已经出现合计金额或银行卡输入框时才算
const PAY_WEAK = /^\s*(finish|完成|confirm|确认|submit|提交|done|ok|好的)\s*$/i;
const PAY_CONTEXT = /(checkout|check-out|cart|order|payment|pay|billing|结算|订单|收银|支付|购物车)/i;
const PAY_EXCLUDE = /^(去结算|结算|checkout|proceed to checkout|继续购物|continue shopping|加入购物车|add to cart|cancel|取消|back|返回)$/i;

function logLine(record: Record<string, unknown>) {
	try {
		const file = join(DATA, "logs", "browser.jsonl");
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), chatId: process.env.PIBOT_CHAT_ID, ...record }) + "\n");
	} catch {}
}
function approvalTimeoutMs() {
	try {
		const p = JSON.parse(readFileSync(String(process.env.PIBOT_INTERRUPT_POLICY), "utf8"));
		return (p.approval?.timeoutMinutes ?? 10) * 60_000;
	} catch {
		return 600_000;
	}
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => {
	const d = new Date(Date.now() + 8 * 3600_000); // 北京时间
	return d.toISOString().replace(/[-:T]/g, "").slice(0, 14).replace(/^(\d{8})(\d{6})/, "$1-$2");
};
const text = (t: string, details: Record<string, unknown> = {}, isError = false) => ({ content: [{ type: "text", text: t }], details, isError }) as any;

class Aborted extends Error {}
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return p;
	if (signal.aborted) return Promise.reject(new Aborted("aborted"));
	return new Promise<T>((res, rej) => {
		const on = () => rej(new Aborted("aborted"));
		signal.addEventListener("abort", on, { once: true });
		p.then(
			(v) => (signal.removeEventListener("abort", on), res(v)),
			(e) => (signal.removeEventListener("abort", on), rej(e)),
		);
	});
}

type Vault = Record<string, { site?: string; fields?: Record<string, string>; [k: string]: unknown }>;
function loadVault(): Vault {
	try {
		const st = statSync(VAULT);
		if ((st.mode & 0o077) !== 0) logLine({ event: "vault_perm_warning", mode: (st.mode & 0o777).toString(8) });
		return JSON.parse(readFileSync(VAULT, "utf8"));
	} catch {
		return {};
	}
}
const fieldsOf = (e: any): Record<string, string> => (e?.fields && typeof e.fields === "object" ? e.fields : Object.fromEntries(Object.entries(e ?? {}).filter(([k, v]) => k !== "site" && k !== "note" && typeof v === "string"))) as any;
const hostOk = (host: string, site?: string) => !!site && site.split(/[,\s]+/).filter(Boolean).some((s) => host === s || host.endsWith("." + s));

export default function (pi: ExtensionAPI) {
	let browser: any = null;
	let page: any = null;
	let lock: Promise<unknown> = Promise.resolve();
	const approvalMs = approvalTimeoutMs();

	// ---- 录屏（每次运行一段）----
	type Run = { id: string; dir: string; frames: number; cdp: any; cdpPage: any; shots: string[]; sent: number; steps: any[]; t0: number };
	let run: Run | null = null;
	let runSeq = 0;

	async function ensureBrowser(signal?: AbortSignal) {
		if (browser?.isConnected()) return browser;
		const tryConnect = async () => {
			try {
				return await chromium.connectOverCDP(CDP, { timeout: 5000 });
			} catch {
				return null;
			}
		};
		let b = await tryConnect();
		if (!b) {
			// 没有常驻服务就自己拉起来（setsid 脱离会话；profile 持久，登录不丢）
			logLine({ event: "browser_autostart" });
			const p = spawn("setsid", ["bash", join(REPO, "scripts/browser.sh")], { detached: true, stdio: "ignore", env: { ...process.env, PIBOT_DATA_DIR: DATA } });
			p.unref();
			for (let i = 0; i < 30 && !b; i++) {
				if (signal?.aborted) throw new Aborted("aborted");
				await sleep(700);
				b = await tryConnect();
			}
		}
		if (!b) throw new Error("浏览器没起来（127.0.0.1 调试端口连不上）。请检查 systemctl status pi-bot-cn-browser");
		browser = b;
		browser.on("disconnected", () => ((browser = null), (page = null)));
		const ctx = browser.contexts()[0];
		ctx.on("page", (p: any) => {
			// 点链接弹出新标签页：自动切过去
			page = p;
			logLine({ event: "tab_switch", url: p.url() });
			if (run) attachRecorder(p).catch(() => {});
		});
		return browser;
	}
	async function getPage(signal?: AbortSignal) {
		await ensureBrowser(signal);
		const ctx = browser.contexts()[0];
		if (!page || page.isClosed()) {
			const pages = ctx.pages().filter((p: any) => !p.isClosed());
			page = pages.at(-1) ?? (await ctx.newPage());
		}
		if (run && run.cdpPage !== page) await attachRecorder(page).catch(() => {});
		return page;
	}

	function startRun() {
		if (run) return run;
		const id = `${stamp()}-${++runSeq}`;
		const dir = join(DATA, "recordings", id);
		mkdirSync(join(dir, "frames"), { recursive: true });
		mkdirSync(join(dir, "shots"), { recursive: true });
		run = { id, dir, frames: 0, cdp: null, cdpPage: null, shots: [], sent: 0, steps: [], t0: Date.now() };
		logLine({ event: "recording_start", id });
		return run;
	}
	async function attachRecorder(p: any) {
		const r = run;
		if (!r) return;
		if (r.cdp) {
			try {
				await r.cdp.send("Page.stopScreencast");
				await r.cdp.detach();
			} catch {}
		}
		r.cdpPage = p;
		const cdp = await p.context().newCDPSession(p);
		r.cdp = cdp;
		cdp.on("Page.screencastFrame", async (f: any) => {
			try {
				await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId });
			} catch {}
			if (run !== r) return;
			const now = Date.now();
			if (now - (r as any).lastFrame < REC_MIN_GAP_MS) return;
			if (r.frames >= REC_MAX_FRAMES) {
				if (!(r as any).capped) {
					(r as any).capped = true;
					logLine({ event: "recording_capped", id: r.id, frames: r.frames });
					cdp.send("Page.stopScreencast").catch(() => {});
				}
				return;
			}
			(r as any).lastFrame = now;
			const name = String(++r.frames).padStart(6, "0") + ".jpg";
			try {
				writeFileSync(join(r.dir, "frames", name), Buffer.from(f.data, "base64"));
				appendFileSync(join(r.dir, "frames.txt"), `${name} ${Date.now()}\n`);
			} catch {}
		});
		await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 860, everyNthFrame: 1 });
	}
	async function finishRun(reason: string) {
		const r = run;
		if (!r) return;
		run = null;
		try {
			await r.cdp?.send("Page.stopScreencast");
			await r.cdp?.detach();
		} catch {}
		writeFileSync(join(r.dir, "steps.json"), JSON.stringify({ id: r.id, reason, startedAt: new Date(r.t0).toISOString(), seconds: Math.round((Date.now() - r.t0) / 1000), shots: r.shots, steps: r.steps }, null, 1));
		logLine({ event: "recording_end", id: r.id, frames: r.frames, shots: r.shots.length, reason });
		if (r.frames >= 2) {
			const p = spawn(process.execPath, [join(REPO, "browser/make-gif.mjs"), r.dir], { detached: true, stdio: "ignore" });
			p.unref();
		}
	}
	pi.on("agent_end", async () => {
		await finishRun("agent_end");
	});
	pi.on("session_shutdown", async () => {
		await finishRun("shutdown");
		try {
			// 只断开 CDP 连接，不关浏览器（浏览器归 systemd 管，登录状态留着）
			await browser?.close?.();
		} catch {}
	});

	async function shot(p: any, tag: string, fullPage = false) {
		const r = startRun();
		const file = join(r.dir, "shots", `${String(r.shots.length + 1).padStart(2, "0")}-${tag.replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 30)}.png`);
		await p.screenshot({ path: file, fullPage, timeout: 15000, animations: "disabled" });
		r.shots.push(file);
		return file;
	}

	async function snapshot(p: any, { maxChars = 6000, offset = 0, find = "" } = {}) {
		const frames = p.frames();
		const all: string[] = [];
		let scrollPct = 100;
		let title = "";
		for (let i = 0; i < frames.length && i < 8; i++) {
			const f = frames[i];
			if (i > 0) {
				try {
					const fe = await f.frameElement();
					const box = await fe.boundingBox();
					if (!box || box.width < 40 || box.height < 20) continue;
				} catch {
					continue;
				}
			}
			try {
				const res: any = await f.evaluate(`(${SNAP_JS})(${JSON.stringify(i === 0 ? "e" : `f${i}e`)})`);
				if (i === 0) ((scrollPct = res.scrollPct), (title = res.title));
				else if (res.lines.length) all.push(`—— 内嵌框架 ${i}（${new URL(f.url()).host}）——`);
				all.push(...res.lines);
			} catch {}
		}
		// 浏览器早于本次连接打开的页面：跨域内嵌框架（如 Stripe 的付款框）有时连不上，提示模型重开当前页
		try {
			const known = new Set(frames.map((f: any) => f.url().split("#")[0]));
			const lost: string[] = await p.evaluate(() =>
				[...document.querySelectorAll("iframe")]
					.filter((f: any) => f.src && /^https?:/.test(f.src) && f.getBoundingClientRect().width > 100 && f.getBoundingClientRect().height > 60)
					.map((f: any) => f.src.split("#")[0]),
			);
			const miss = lost.filter((u) => !known.has(u));
			if (miss.length) all.push(`（有 ${miss.length} 个内嵌框架读不到内容，来自 ${[...new Set(miss.map((u) => new URL(u).host))].join("、")}：用 browser_open 重新打开当前网址就能看到）`);
		} catch {}
		let lines = all;
		if (find) {
			const k = find.toLowerCase();
			const hit = new Set<number>();
			lines.forEach((l, i) => {
				if (l.toLowerCase().includes(k)) for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 3); j++) hit.add(j);
			});
			lines = [...hit].sort((a, b) => a - b).map((i) => lines[i]);
			if (!lines.length) lines = [`（页面里没找到「${find}」）`];
		}
		let body = lines.join("\n");
		const totalLen = body.length;
		body = body.slice(offset, offset + maxChars);
		const more = totalLen > offset + maxChars ? `\n…（后面还有约 ${totalLen - offset - maxChars} 字：browser_snapshot 传 offset=${offset + maxChars} 继续看，或用 find 搜关键词）` : "";
		return `页面：${title || "(无标题)"}｜${p.url()}｜已看到 ${scrollPct}%\n${body}${more}`;
	}

	async function locate(p: any, refArg: string) {
		const ref = String(refArg ?? "").replace(/^\[|\]$/g, "").trim();
		if (!/^(f\d+)?e\d+$/.test(ref)) throw new Error(`编号「${refArg}」不对，应该是快照里方括号中的编号，比如 e12`);
		const fi = /^f(\d+)e/.exec(ref);
		const frames = p.frames();
		const order = fi ? [frames[Number(fi[1])], ...frames] : frames;
		for (const f of order) {
			if (!f) continue;
			const loc = f.locator(`[data-pi-ref="${ref}"]`);
			try {
				if ((await loc.count()) > 0) return { loc: loc.first(), frame: f, ref };
			} catch {}
		}
		throw new Error(`页面上找不到 [${ref}]（页面可能已经变了）。先 browser_snapshot 拿最新编号再试`);
	}
	/** 按看得到的文字找元素（所有框架里找，先精确后模糊，只要看得见的） */
	async function locateText(p: any, t: string) {
		for (const exact of [true, false])
			for (const f of p.frames()) {
				try {
					const all = f.getByText(t, { exact });
					const n = Math.min(await all.count(), 10);
					for (let i = 0; i < n; i++) if (await all.nth(i).isVisible()) return all.nth(i);
				} catch {}
			}
		throw new Error(`页面上没找到看得见的「${t}」。先 browser_snapshot 看看现在页面上有什么`);
	}
	async function flash(loc: any) {
		try {
			await loc.evaluate((el: any) => {
				const o = el.style.outline, of = el.style.outlineOffset;
				el.style.outline = "3px solid #ff3b30";
				el.style.outlineOffset = "2px";
				setTimeout(() => ((el.style.outline = o), (el.style.outlineOffset = of)), 700);
			});
			await sleep(250);
		} catch {}
	}
	async function settle(p: any, signal?: AbortSignal) {
		await abortable(sleep(500), signal);
		try {
			await abortable(p.waitForLoadState("domcontentloaded", { timeout: 10000 }), signal);
		} catch (e) {
			if (e instanceof Aborted) throw e;
		}
		try {
			await abortable(p.waitForLoadState("networkidle", { timeout: 2500 }), signal);
		} catch (e) {
			if (e instanceof Aborted) throw e;
		}
	}
	async function elInfo(loc: any) {
		return loc.evaluate((el: any) => ({
			text: String(el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").replace(/\s+/g, " ").trim().slice(0, 80),
			type: String(el.type || "").toLowerCase(),
			tag: el.tagName.toLowerCase(),
			secret: el.getAttribute("data-pi-secret") === "1",
		}));
	}
	async function pageMoney(p: any) {
		try {
			const t: string = await p.evaluate(() => document.body?.innerText ?? "");
			const re = /(total|合计|总计|应付|实付|总价|金额|amount due|pay)[^\n\d¥$€£]{0,16}([¥$€£]\s?[\d,]+(\.\d{1,2})?|[\d,]+(\.\d{1,2})?\s?(元|USD|CNY))/gi;
			let m, last = "";
			while ((m = re.exec(t))) last = m[0].replace(/\s+/g, " ").trim();
			if (last) return last.slice(0, 60);
			const any = t.match(/[¥$€£]\s?[\d,]+\.\d{2}/g);
			return any ? any.at(-1) : "";
		} catch {
			return "";
		}
	}
	/** 是不是「最后一步」的结算页：网址/标题像结算，并且页面上有合计金额或银行卡输入框 */
	async function payPage(p: any) {
		const title = await p.title().catch(() => "");
		if (!PAY_CONTEXT.test(p.url() + " " + title)) return false;
		const cards = await p.locator('input[autocomplete*="cc-"], input[name*="card" i], input[id*="card" i], iframe[name*="card" i], iframe[title*="card" i], iframe[title*="支付"]').count().catch(() => 0);
		if (cards > 0) return true;
		const t: string = await p.evaluate(() => document.body?.innerText ?? "").catch(() => "");
		return /(total|合计|总计|应付|实付|amount due)[^\n\d]{0,16}[¥$€£]?\s?[\d,]+(\.\d{1,2})?/i.test(t);
	}
	async function isPayment(label: string, p: any) {
		const l = label.trim();
		if (!l || PAY_EXCLUDE.test(l)) return false;
		if (PAY_STRONG.test(l)) return true;
		return PAY_WEAK.test(l) && (await payPage(p));
	}
	/** 付款前：截图 + 「要付款了」审批卡（critical：始终允许也问）。返回 true=主人同意。 */
	async function askPayment(ctx: any, p: any, label: string, signal?: AbortSignal) {
		if (!ctx?.hasUI || !ctx?.ui?.confirm) return false;
		const image = await shot(p, "付款前确认");
		const host = new URL(p.url()).host;
		const money = await pageMoney(p);
		const t0 = Date.now();
		logLine({ event: "payment_approval_request", host, label, money });
		const ok = await ctx.ui.confirm(
			"pibot-approval",
			JSON.stringify({ tool: "browser", kind: "payment", command: `在 ${host} 点「${label}」${money ? `（${money}）` : ""}`, why: "是付款 / 下单操作", critical: true, image, host, label, money, timeoutMs: approvalMs }),
			{ timeout: approvalMs + 30_000, signal },
		);
		logLine({ event: "payment_approval_result", host, label, approved: !!ok, waitedMs: Date.now() - t0 });
		return !!ok;
	}
	const denied = (what: string) =>
		text(
			`[没有得到同意] ${what} 没有执行（对方拒绝了，或者一直没回复）。不要换别的按钮/回车/脚本绕过，也不要再申请同一个付款。审批卡上已经显示结果了：要么不说话，要么只说一句很短的话（20 字以内，用「你」称呼对方）。`,
			{ denied: true },
			true,
		);

	function step(tool: string, args: Record<string, unknown>) {
		const r = startRun();
		r.steps.push({ t: Math.round((Date.now() - r.t0) / 100) / 10, tool, ...args });
	}

	/** 所有浏览器动作串行执行（模型有时并行调工具） + 统一错误处理 */
	function tool(name: string, label: string, description: string, parameters: any, fn: (params: any, signal: AbortSignal | undefined, ctx: any) => Promise<any>, extra: Record<string, unknown> = {}) {
		pi.registerTool({
			name,
			label,
			description,
			parameters,
			...extra,
			async execute(_id: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
				const prev = lock;
				let release: () => void = () => {};
				lock = new Promise<void>((r) => (release = r));
				try {
					await abortable(prev.catch(() => {}), signal);
					return await fn(params ?? {}, signal, ctx);
				} catch (e: any) {
					if (e instanceof Aborted || signal?.aborted) {
						logLine({ event: "aborted", tool: name });
						return text("[被用户打断] 浏览器动作已停下。不要重做这一步，按用户最新的话继续（喊停就什么都不用说）。", { interrupted: true }, true);
					}
					const msg = String(e?.message ?? e).split("\n")[0].slice(0, 300);
					logLine({ event: "tool_error", tool: name, err: msg });
					return text(`出错了：${msg}`, {}, true);
				} finally {
					release();
				}
			},
		} as any);
	}

	const S = Type.String;
	const O = Type.Optional;

	tool(
		"browser_open",
		"打开网页",
		"在自己的浏览器（真 Chromium，登录状态会保留）里打开网址，返回页面内容快照（可交互元素带 [e12] 这样的编号，后面点击/输入用它）。",
		Type.Object({ url: S({ description: "网址，可省略 https://" }) }),
		async ({ url }, signal) => {
			let u = String(url).trim();
			if (!/^[a-z]+:/i.test(u)) u = "https://" + u;
			if (/^(file|chrome|javascript|data):/i.test(u)) throw new Error("只允许打开 http/https 网址");
			const p = await getPage(signal);
			startRun();
			if (run && run.cdpPage !== p) await attachRecorder(p).catch(() => {});
			step("open", { url: u });
			// 只等到「开始提交」：有些站点（跳转/验证页）的 domcontentloaded 事件偶尔收不到，剩下的交给 settle 有限等待
			try {
				await abortable(p.goto(u, { waitUntil: "commit", timeout: 30000 }), signal);
			} catch (e: any) {
				if (e instanceof Aborted || signal?.aborted) throw e;
				if (!/timeout/i.test(String(e?.message))) throw e;
			}
			await settle(p, signal);
			return text(await snapshot(p, { maxChars: 5000 }));
		},
		{ promptSnippet: "用自己的浏览器打开网页（真 Chromium，可登录、点击、填表、截图）" },
	);

	tool(
		"browser_snapshot",
		"看页面",
		"重新读取当前页面内容（带元素编号）。页面很长时用 offset 翻页，或用 find 只看包含某个关键词的部分。",
		Type.Object({ offset: O(Type.Number()), find: O(S({ description: "只看包含这个词的地方" })), max_chars: O(Type.Number()) }),
		async ({ offset, find, max_chars }, signal) => {
			const p = await getPage(signal);
			return text(await abortable(snapshot(p, { offset: offset ?? 0, find: find ?? "", maxChars: Math.min(max_chars ?? 6000, 12000) }), signal));
		},
	);

	tool(
		"browser_click",
		"点击",
		"点击页面上的元素：优先用快照里的编号（ref，如 e12）；快照里没编号但看得到文字的东西（如「银行卡」这种选项卡），用 text 传那段文字。付款/下单类按钮（Finish、Place order、提交订单、付款…）系统会自动先截图发审批卡问主人，你照常点就行，不用自己先问。",
		Type.Object({ ref: O(S({ description: "元素编号，如 e12" })), text: O(S({ description: "没有编号时，按页面上看得到的文字点" })) }),
		async ({ ref, text: byText }, signal, ctx) => {
			const p = await getPage(signal);
			let loc: any;
			if (ref) loc = (await locate(p, ref)).loc;
			else if (byText) loc = await locateText(p, String(byText));
			else throw new Error("ref 和 text 至少给一个");
			const info = await elInfo(loc);
			const label = info.text || String(byText ?? "");
			step("click", { ref, text: byText, label });
			if ((await isPayment(label, p)) || (byText && (await isPayment(String(byText), p)))) {
				await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
				await flash(loc);
				const ok = await askPayment(ctx, p, label, signal);
				if (signal?.aborted) throw new Aborted("aborted");
				if (!ok) return denied(`付款（「${label}」）`);
			}
			await flash(loc);
			try {
				await abortable(loc.click({ timeout: 8000 }), signal);
			} catch (e) {
				if (e instanceof Aborted) throw e;
				await abortable(loc.click({ timeout: 4000, force: true }), signal);
			}
			await settle(p, signal);
			const cur = page ?? p;
			return text(`点了 ${ref ? `[${ref}]` : "文字"}「${label}」。\n` + (await snapshot(cur, { maxChars: 4000 })));
		},
	);

	tool(
		"browser_type",
		"输入",
		"往输入框里打字（会先清空）。submit=true 时打完按回车。不能用来输密码：密码用 browser_fill_secret。",
		Type.Object({ ref: S(), text: S(), submit: O(Type.Boolean()) }),
		async ({ ref, text: value, submit }, signal, ctx) => {
			const p = await getPage(signal);
			const { loc } = await locate(p, ref);
			const info = await elInfo(loc);
			if (info.type === "password") throw new Error("这是密码框，不能直接输入。用 browser_fill_secret 从密码库填；密码库里没有就问主人（让他在服务器上存进密码库）");
			step("type", { ref, chars: String(value).length, submit: !!submit });
			await flash(loc);
			await abortable(loc.click({ timeout: 6000 }).catch(() => {}), signal);
			await abortable(loc.fill("", { timeout: 6000 }).catch(() => {}), signal);
			await abortable(loc.pressSequentially(String(value), { delay: 25, timeout: 30000 }), signal);
			if (submit) {
				if (await payPage(p)) {
					const ok = await askPayment(ctx, p, "回车提交", signal);
					if (!ok) return denied("付款（回车提交）");
				}
				await abortable(loc.press("Enter"), signal);
				await settle(p, signal);
				return text(`已输入并回车。\n` + (await snapshot(page ?? p, { maxChars: 4000 })));
			}
			return text(`已在 [${ref}] 输入 ${String(value).length} 个字。`);
		},
	);

	tool(
		"browser_press",
		"按键",
		"在当前页面按一个键，如 Enter、Escape、Tab、ArrowDown、PageDown。",
		Type.Object({ key: S() }),
		async ({ key }, signal, ctx) => {
			const p = await getPage(signal);
			step("press", { key });
			if (/^(enter|numpadenter)$/i.test(key) && (await payPage(p))) {
				const ok = await askPayment(ctx, p, "回车提交", signal);
				if (!ok) return denied("付款（回车提交）");
			}
			await abortable(p.keyboard.press(String(key)), signal);
			await settle(p, signal);
			return text(`按了 ${key}。\n` + (await snapshot(page ?? p, { maxChars: 3000 })));
		},
	);

	tool(
		"browser_select",
		"下拉选择",
		"在下拉框里选一项（按显示的文字或值）。",
		Type.Object({ ref: S(), option: S() }),
		async ({ ref, option }, signal) => {
			const p = await getPage(signal);
			const { loc } = await locate(p, ref);
			step("select", { ref, option });
			await flash(loc);
			try {
				await abortable(loc.selectOption({ label: String(option) }, { timeout: 5000 }), signal);
			} catch (e) {
				if (e instanceof Aborted) throw e;
				await abortable(loc.selectOption(String(option), { timeout: 5000 }), signal);
			}
			await settle(p, signal);
			return text(`选了「${option}」。\n` + (await snapshot(p, { maxChars: 3000 })));
		},
	);

	tool(
		"browser_scroll",
		"滚动",
		"滚动页面：down / up 一屏，或 top / bottom。",
		Type.Object({ direction: S({ description: "down | up | top | bottom" }), screens: O(Type.Number()) }),
		async ({ direction, screens }, signal) => {
			const p = await getPage(signal);
			const n = Math.max(1, Math.min(Number(screens ?? 1), 10));
			step("scroll", { direction, n });
			await abortable(
				p.evaluate(
					([d, k]: any) => {
						const se = document.scrollingElement || document.documentElement;
						if (d === "top") se.scrollTo({ top: 0, behavior: "smooth" });
						else if (d === "bottom") se.scrollTo({ top: se.scrollHeight, behavior: "smooth" });
						else se.scrollBy({ top: (d === "up" ? -1 : 1) * innerHeight * 0.85 * k, behavior: "smooth" });
					},
					[String(direction), n],
				),
				signal,
			);
			await abortable(sleep(900), signal);
			await settle(p, signal);
			return text(await snapshot(p, { maxChars: 4000 }));
		},
	);

	tool(
		"browser_wait",
		"等待",
		"等页面出现某段文字（最多 seconds 秒，默认 10），或者干等几秒。",
		Type.Object({ text: O(S()), seconds: O(Type.Number()) }),
		async ({ text: t, seconds }, signal) => {
			const p = await getPage(signal);
			const ms = Math.min(Math.max(Number(seconds ?? (t ? 10 : 2)), 0.5), 60) * 1000;
			step("wait", { text: t, ms });
			if (t) {
				try {
					await abortable(p.getByText(String(t)).first().waitFor({ timeout: ms }), signal);
				} catch (e) {
					if (e instanceof Aborted) throw e;
					return text(`等了 ${ms / 1000} 秒，没等到「${t}」。\n` + (await snapshot(p, { maxChars: 3000 })));
				}
			} else await abortable(sleep(ms), signal);
			return text(await snapshot(p, { maxChars: 4000 }));
		},
	);

	tool("browser_back", "后退", "浏览器后退一页。", Type.Object({}), async (_p, signal) => {
		const p = await getPage(signal);
		step("back", {});
		await abortable(p.goBack({ waitUntil: "commit", timeout: 15000 }), signal).catch((e: any) => {
			if (e instanceof Aborted || signal?.aborted) throw e;
		});
		await settle(p, signal);
		return text(await snapshot(p, { maxChars: 4000 }));
	});

	tool(
		"browser_screenshot",
		"截图",
		"给当前页面截图。send=true 时把截图发给主人（附一句 caption）。只在值得看的时刻发：最终结果、付款/订单完成页、需要主人看一眼的东西；一次任务最多发两三张，别每一步都发。",
		Type.Object({ send: O(Type.Boolean()), caption: O(S()), full_page: O(Type.Boolean()) }),
		async ({ send, caption, full_page }, signal) => {
			const p = await getPage(signal);
			const file = await abortable(shot(p, send ? "发给主人" : "截图", !!full_page), signal);
			step("screenshot", { send: !!send, file: basename(file) });
			if (send) {
				const r = startRun();
				if (r.sent >= MAX_SHOTS_PER_RUN) return text(`截图已保存：${file}。这次任务已经发了 ${r.sent} 张，别再发了，直接用文字说结果。`);
				r.sent++;
				return text(`截图已发给主人（${basename(file)}）。不用再描述截图里有什么，接着说要说的话就好。`, { pibotImage: { path: file, caption: String(caption ?? "").slice(0, 200) } });
			}
			return text(`截图已保存：${file}`);
		},
	);

	tool(
		"browser_download",
		"下载",
		"下载文件：点击某个下载链接/按钮（ref），或者直接给 url。文件存到服务器上，返回路径；要给主人就再用 send_file。",
		Type.Object({ ref: O(S()), url: O(S()) }),
		async ({ ref, url }, signal) => {
			const p = await getPage(signal);
			mkdirSync(DL_DIR, { recursive: true });
			step("download", { ref, url });
			if (url) {
				const res = await abortable(p.request.get(String(url), { timeout: 60000 }), signal);
				if (!res.ok()) throw new Error(`下载失败 HTTP ${res.status()}`);
				const name = (basename(new URL(String(url), p.url()).pathname) || "download").slice(0, 80);
				const file = join(DL_DIR, `${stamp()}-${name}`);
				writeFileSync(file, await res.body());
				return text(`下载好了：${file}（${statSync(file).size} 字节）`);
			}
			const { loc } = await locate(p, String(ref));
			const [dl] = await abortable(Promise.all([p.waitForEvent("download", { timeout: 30000 }), loc.click({ timeout: 8000 })]), signal);
			const file = join(DL_DIR, `${stamp()}-${dl.suggestedFilename()}`);
			await dl.saveAs(file);
			return text(`下载好了：${file}（${statSync(file).size} 字节）`);
		},
	);

	tool(
		"browser_list_secrets",
		"密码库条目",
		"列出密码库里存了哪些登录（只有名字、网站、字段名，没有密码本身）。",
		Type.Object({}),
		async () => {
			const v = loadVault();
			const items = Object.entries(v).map(([name, e]) => `- ${name}：网站 ${e?.site ?? "(未登记，不能用)"}，字段 ${Object.keys(fieldsOf(e)).join(" / ")}`);
			return text(items.length ? `密码库（内容不显示）：\n${items.join("\n")}` : "密码库是空的。需要登录时请主人在服务器上运行 node scripts/vault.mjs set <名字> 存进去（密码不会经过聊天）。");
		},
	);

	tool(
		"browser_fill_secret",
		"填密码库",
		"把密码库里某条登录的某个字段（如 username / password）直接填进输入框。值不会出现在你的上下文里；只能填进该条目登记的网站。",
		Type.Object({ ref: S(), name: S({ description: "密码库条目名" }), field: S({ description: "字段名，如 username、password" }) }),
		async ({ ref, name, field }, signal) => {
			const p = await getPage(signal);
			const e = loadVault()[String(name)];
			if (!e) throw new Error(`密码库里没有「${name}」。用 browser_list_secrets 看有哪些；没有就请主人存`);
			const host = new URL(p.url()).host;
			if (!hostOk(host, e.site)) {
				logLine({ event: "vault_site_mismatch", name, host });
				throw new Error(`「${name}」只能填进 ${e.site ?? "(未登记网站)"}，当前页面是 ${host}，拒绝填写`);
			}
			const val = fieldsOf(e)[String(field)];
			if (typeof val !== "string") throw new Error(`「${name}」里没有字段「${field}」，有：${Object.keys(fieldsOf(e)).join(" / ")}`);
			const { loc } = await locate(p, ref);
			step("fill_secret", { ref, name, field });
			await flash(loc);
			await abortable(loc.fill(val, { timeout: 8000 }), signal);
			await loc.evaluate((el: any) => el.setAttribute("data-pi-secret", "1")).catch(() => {});
			logLine({ event: "vault_fill", name, field, host });
			return text(`已把「${name}」的 ${field} 填进 [${ref}]（内容不显示）。`);
		},
	);

	tool(
		"browser_ask_owner",
		"问主人",
		"网页要验证码、短信码、扫码、人机验证或别的只有主人知道的东西时，用它问主人。question 是发给主人的一句自然的话。给了 ref 时，主人回的内容直接填进这个输入框，不会经过你（secret 默认 true）。主人要自己去手机上点确认/扫码时，ref 不填、secret=false，主人回「好了」你就继续。不要用它确认付款/下单：直接点付款按钮，系统会自动截图发审批卡给主人（主人说「付款前让我确认」也是靠这个）。",
		Type.Object({ question: S(), ref: O(S()), secret: O(Type.Boolean()), submit: O(Type.Boolean({ description: "填完按回车" })) }),
		async ({ question, ref, secret, submit }, signal, ctx) => {
			const p = await getPage(signal);
			const isSecret = secret !== false && !!ref;
			if (ref) await locate(p, ref); // 先确认输入框在
			const image = await shot(p, "需要主人帮忙").catch(() => undefined);
			step("ask_owner", { ref, secret: isSecret });
			if (!ctx?.hasUI || !ctx?.ui?.input) throw new Error("当前通道没法问主人");
			const timeoutMs = 5 * 60_000;
			const t0 = Date.now();
			const value = await ctx.ui.input("pibot-input", JSON.stringify({ question: String(question).slice(0, 300), secret: isSecret, image, host: new URL(p.url()).host, timeoutMs }), { timeout: timeoutMs + 15_000, signal });
			if (signal?.aborted) throw new Aborted("aborted");
			logLine({ event: "ask_owner_result", got: typeof value === "string", secret: isSecret, chars: value?.length ?? 0, waitedMs: Date.now() - t0 });
			if (typeof value !== "string" || !value.trim()) return text("主人没有回复（或者取消了）。别再问同样的问题，简短说一句卡在哪了。", { noAnswer: true }, true);
			if (!ref) return text(`主人回复：「${value.trim().slice(0, 500)}」`);
			const cur = page ?? p;
			const { loc } = await locate(cur, ref);
			await flash(loc);
			await loc.click({ timeout: 5000 }).catch(() => {});
			await loc.fill("", { timeout: 5000 }).catch(() => {});
			await cur.keyboard.type(value.trim(), { delay: 60 });
			if (isSecret) await loc.evaluate((el: any) => el.setAttribute("data-pi-secret", "1")).catch(() => {});
			if (submit) {
				await cur.keyboard.press("Enter");
				await settle(cur, signal);
			}
			const head = isSecret ? `主人给了（${value.trim().length} 个字符，内容不显示），已填进 [${ref}]${submit ? "并回车" : ""}。` : `主人回复「${value.trim()}」，已填进 [${ref}]。`;
			return text(head + "\n" + (await snapshot(cur, { maxChars: 3000 })));
		},
	);

	tool(
		"send_file",
		"发文件",
		"把服务器上的一个文件（表格、CSV、PDF、图片等）发给主人。",
		Type.Object({ path: S(), caption: O(S()) }),
		async ({ path, caption }) => {
			const file = resolve(process.cwd(), String(path).replace(/^@/, ""));
			if (/(\/\.ssh\/|\/\.config\/pi-bot-cn|\.env\b|\.pem$|id_(rsa|ed25519)|vault)/i.test(file)) throw new Error("这个文件涉及密钥，不能发");
			if (!existsSync(file)) throw new Error(`文件不存在：${file}`);
			const size = statSync(file).size;
			if (size > 30 * 1024 * 1024) throw new Error("文件超过 30MB，飞书发不了");
			logLine({ event: "send_file", file, size });
			return text(`文件已发给主人：${basename(file)}（${size} 字节）。`, { pibotFile: { path: file, name: basename(file), caption: String(caption ?? "").slice(0, 200) } });
		},
	);

	// 密码库、环境变量文件：read / grep 等内置工具一律不让读（bash 读会触发「特别危险」审批卡）
	pi.on("tool_call", async (event: any) => {
		if (!["read", "grep", "find", "ls"].includes(event.toolName)) return;
		const s = JSON.stringify(event.input ?? {});
		if (/\.config\/pi-bot-cn|vault\.json|\/\.ssh\//.test(s)) return { block: true, reason: "密钥/密码库文件不允许读取。需要登录就用 browser_fill_secret 按名字填。" };
	});
}
