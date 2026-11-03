// 飞书通道（一等公民）：只走长连接（WSClient），不对公网开任何端口。
// - 收消息：im.message.receive_v1（文本 / 富文本 post）
// - 卡片回调：card.action.trigger（同一条长连接；流式卡片上的「停止」按钮 → 网关按「停」处理）
// - 发消息：im.v1.message.reply（回复主人那条消息）/ im.v1.message.create（主动发）
// - 回答（purpose=card）：一次运行一张「只有回答正文」的卡片，首段文字出现时发出，之后 im.v1.message.patch 原地更新；
//   生成中卡片底部有一个不起眼的小「停止」文字按钮，结束后去掉。没有步骤列表、没有状态文字。
// - 审批（purpose=approval）：危险命令前发「可以，执行 / 先别」卡片；点了之后原地改成一句自然的话。
// - 卡片优先用 JSON 2.0（schema 2.0，config.update_multi=true），发不出去自动退回 1.0。
// - 只有 PI_BOT_OWNER_OPEN_IDS 白名单里的人能触发模型（Gate 在进模型之前）；白名单为空时只记录日志并放行私聊。
// - 环境里出现 FEISHU_APP_ID/SECRET 即自动启用；连接断了 SDK 自动重连，SDK 放弃后我们 15s 后整体重建。
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const CARD_MAX = 9000; // 单卡正文上限（飞书卡片 ~30KB，留足余量）

function card(text, { done, title }) {
	// 旧版流式卡（purpose=stream，兼容重启前积压的消息）
	const elements = [{ tag: "markdown", content: text || "…" }];
	if (!done)
		elements.push({
			tag: "action",
			actions: [{ tag: "button", text: { tag: "plain_text", content: "停止" }, type: "default", value: { pibot: "stop" } }],
		});
	return {
		config: { wide_screen_mode: true, update_multi: true },
		header: title ? { template: done ? "green" : "blue", title: { tag: "plain_text", content: title } } : undefined,
		elements,
	};
}

// ---- 回答卡：只放回答正文；生成中多一个小小的「停止」文字按钮 ----
function answerCard(text, done, v) {
	const body = text || " ";
	if (v === 1) {
		const elements = [{ tag: "markdown", content: body }];
		if (!done) elements.push({ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "停止" }, type: "default", value: { pibot: "stop" } }] });
		return { config: { wide_screen_mode: true, update_multi: true }, elements };
	}
	const elements = [{ tag: "markdown", content: body }];
	if (!done)
		elements.push({
			tag: "button",
			text: { tag: "plain_text", content: "停止" },
			type: "text",
			size: "tiny",
			behaviors: [{ type: "callback", value: { pibot: "stop" } }],
		});
	return { schema: "2.0", config: { update_multi: true, width_mode: "fill" }, body: { elements } };
}

// ---- 审批卡：一句自然的问话 + 命令 + 两个按钮；决定后原地改成一句话、去掉按钮 ----
const DECIDED = {
	approved: "👌 好，你同意了，我这就执行。",
	approved_always: "👌 好，这就执行；以后一般的危险命令我直接做，不再问你（特别危险的还是会问）。",
	denied: "好，这条先不做。",
	timeout: "等了 10 分钟没等到你回复，这条我先不做了。",
	cancelled: "好，不做了。",
};
function approvalCard(a, v) {
	const mins = Math.round((a.timeoutMs ?? 600_000) / 60_000);
	const ask = `接下来这条命令${a.why ? `**${a.why}**` : "有点危险"}，你同意我执行吗？${a.critical ? "\n<font color='grey'>（这类特别危险的命令，就算设了「始终允许」也会每次问你）</font>" : ""}`;
	const code = "```bash\n" + String(a.command ?? "").slice(0, 1500) + "\n```";
	const decided = a.state && a.state !== "pending";
	// 拒绝后模型自己说的那句话（如果有）替换掉卡上的结果行
	const tail = decided ? (a.note ? String(a.note).slice(0, 300) : DECIDED[a.state] ?? "好。") : `（${mins} 分钟内没回复我就先不做；直接回我「可以」「先别」也行）`;
	const val = (ok, always) => (always ? { pibot: "approval", id: a.approvalId, ok, always: true } : { pibot: "approval", id: a.approvalId, ok });
	if (v === 1) {
		const elements = [
			{ tag: "markdown", content: `${ask}\n${code}` },
			decided ? { tag: "markdown", content: tail } : { tag: "note", elements: [{ tag: "plain_text", content: tail }] },
		];
		if (!decided)
			elements.push({
				tag: "action",
				actions: [
					{ tag: "button", text: { tag: "plain_text", content: "可以，执行" }, type: "primary", value: val(true) },
					{ tag: "button", text: { tag: "plain_text", content: "先别" }, type: "default", value: val(false) },
					...(a.critical ? [] : [{ tag: "button", text: { tag: "plain_text", content: "以后都允许" }, type: "default", value: val(true, true) }]),
				],
			});
		return { config: { wide_screen_mode: true, update_multi: true }, elements };
	}
	const btn = (label, type, ok, always) => ({ tag: "button", text: { tag: "plain_text", content: label }, type, size: "medium", behaviors: [{ type: "callback", value: val(ok, always) }] });
	const elements = [{ tag: "markdown", content: `${ask}\n${code}` }];
	if (decided) elements.push({ tag: "markdown", content: tail });
	else
		elements.push(
			{ tag: "markdown", content: `<font color='grey'>${tail}</font>`, text_size: "notation" },
			{
				tag: "column_set",
				flex_mode: "none",
				columns: [
					{ tag: "column", width: "auto", elements: [btn("可以，执行", "primary_filled", true)] },
					{ tag: "column", width: "auto", elements: [btn("先别", "default", false)] },
					...(a.critical ? [] : [{ tag: "column", width: "auto", elements: [btn("以后都允许", "default", true, true)] }]),
				],
			},
		);
	return { schema: "2.0", config: { update_multi: true, width_mode: "fill" }, body: { elements } };
}

// ---- 授权设置卡：显示当前模式 + 「每次询问 / 始终允许」两个按钮；点了原地更新 ----
function modeCard(m, v) {
	const cur = m.mode === "always" ? "always" : "ask";
	const head = `**危险命令授权**　现在是：**${cur === "always" ? "始终允许" : "每次询问"}**`;
	const desc =
		"· **每次询问**：执行危险命令（删文件、sudo、推送代码等）前先发卡片问你\n" +
		"· **始终允许**：一般的危险命令直接做，不再问你\n" +
		"<font color='grey'>删整个系统、格式化磁盘、关机重启、改我自己的密钥这类特别危险的命令，两种模式下都会先问你。</font>";
	const val = (mode) => ({ pibot: "mode", mode, card: m.modeCardId });
	const label = (mode) => (mode === cur ? "✓ " : "") + (mode === "always" ? "始终允许" : "每次询问");
	if (v === 1) {
		const elements = [{ tag: "markdown", content: `${head}\n${desc}` }];
		if (m.note) elements.push({ tag: "markdown", content: m.note });
		elements.push({
			tag: "action",
			actions: ["ask", "always"].map((mode) => ({ tag: "button", text: { tag: "plain_text", content: label(mode) }, type: mode === cur ? "primary" : "default", value: val(mode) })),
		});
		return { config: { wide_screen_mode: true, update_multi: true }, elements };
	}
	const elements = [{ tag: "markdown", content: `${head}\n${desc}` }];
	if (m.note) elements.push({ tag: "markdown", content: m.note });
	elements.push({
		tag: "column_set",
		flex_mode: "none",
		columns: ["ask", "always"].map((mode) => ({
			tag: "column",
			width: "auto",
			elements: [{ tag: "button", text: { tag: "plain_text", content: label(mode) }, type: mode === cur ? "primary_filled" : "default", size: "medium", behaviors: [{ type: "callback", value: val(mode) }] }],
		})),
	});
	return { schema: "2.0", config: { update_multi: true, width_mode: "fill" }, body: { elements } };
}

// SDK 对非 2xx 抛 axios 错误：把飞书返回体里的 code/msg 带出来（不含任何凭证）
function errStr(e) {
	const d = e?.response?.data;
	if (d && typeof d === "object" && "code" in d) return `code=${d.code} msg=${String(d.msg ?? "").slice(0, 160)}`;
	return String(e?.message ?? e);
}

function ok(res, what) {
	if (res && typeof res.code === "number" && res.code !== 0) throw new Error(`${what} code=${res.code} msg=${res.msg}`);
	return res;
}

export async function createFeishuChannel({ log, dataDir, env = process.env }) {
	const appId = env.FEISHU_APP_ID;
	const appSecret = env.FEISHU_APP_SECRET;
	if (!appId || !appSecret) {
		log("feishu_disabled", { reason: "FEISHU_APP_ID/FEISHU_APP_SECRET 未配置" });
		return null;
	}
	const lark = await import("@larksuiteoapi/node-sdk");
	const domain = env.FEISHU_DOMAIN === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
	const owners = new Set((env.PI_BOT_OWNER_OPEN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
	const client = new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild, domain, loggerLevel: lark.LoggerLevel.warn });

	// 流式卡片状态持久化：重启后同一轮的剩余分片继续 patch 同一张卡
	const stateFile = join(dataDir, "feishu-cards.json");
	let cards = {};
	try {
		if (existsSync(stateFile)) cards = JSON.parse(readFileSync(stateFile, "utf8"));
	} catch {}
	const saveCards = () => {
		const keys = Object.keys(cards);
		if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete cards[k];
		writeFileSync(stateFile + ".tmp", JSON.stringify(cards));
		renameSync(stateFile + ".tmp", stateFile);
	};

	const status = { state: "init", since: Date.now(), lastEventAt: null, lastError: null, reconnects: 0, owners: owners.size, dropped: 0 };
	const setState = (state, extra = {}) => {
		Object.assign(status, { state, since: Date.now() }, extra);
		log("feishu_ws_state", { state, ...extra });
		if (state === "connected") log("FEISHU_WS_CONNECTED", { appIdSuffix: appId.slice(-4) });
	};

	let onInbound = null;
	let onCardAction = null;

	const allowed = (openId, chatType) => {
		if (owners.size) return owners.has(openId);
		return chatType === "p2p"; // 未配白名单：只放行私聊，群聊一律不触发模型
	};

	function extractText(m) {
		let c = {};
		try {
			c = JSON.parse(m.content);
		} catch {}
		if (m.message_type === "text") return c.text ?? "";
		if (m.message_type === "post") {
			const body = c.content ? c : (c.zh_cn ?? c.en_us ?? Object.values(c)[0] ?? {});
			const parts = [];
			if (body.title) parts.push(body.title);
			for (const line of body.content ?? []) parts.push(line.map((x) => x.text ?? x.href ?? "").join(""));
			return parts.join("\n");
		}
		return "";
	}

	const dispatcher = new lark.EventDispatcher({}).register({
		"im.message.receive_v1": async (data) => {
			status.lastEventAt = Date.now();
			const m = data.message;
			const senderId = data.sender?.sender_id?.open_id;
			if (!allowed(senderId, m.chat_type)) {
				status.dropped++;
				log("feishu_gate_drop", { chatType: m.chat_type, hasOwnerList: owners.size > 0 }); // 不调模型
				return;
			}
			if (!owners.size) log("feishu_owner_hint", { senderOpenId: senderId, hint: "把这个 open_id 写进 PI_BOT_OWNER_OPEN_IDS 锁定主人" });
			const text = extractText(m).replace(/@_user_\d+/g, "").trim();
			if (!text) {
				log("feishu_skip", { type: m.message_type });
				return;
			}
			// 不 await：飞书事件需尽快 ack；网关内部按 chat 串行
			onInbound?.({ channel: "feishu", chatId: m.chat_id, senderId, text, receivedAt: Date.now(), messageId: m.message_id });
		},
		"card.action.trigger": async (data) => {
			status.lastEventAt = Date.now();
			const senderId = data.operator?.open_id;
			const chatId = data.context?.open_chat_id ?? data.open_chat_id;
			if (owners.size && !owners.has(senderId)) return { toast: { type: "error", content: "无权限" } };
			const v = data.action?.value ?? {};
			log("feishu_card_action", { chatId, value: v });
			if (v.pibot === "stop" && chatId) {
				onInbound?.({ channel: "feishu", chatId, senderId, text: "停", receivedAt: Date.now(), messageId: null, via: "card" });
				return {}; // 不弹提示：停下来本身就是反馈
			}
			if (v.pibot === "ping") {
				log("feishu_card_ping", { chatId });
				return { toast: { type: "success", content: "按钮回调收到了 👍" } };
			}
			if (onCardAction) return onCardAction({ chatId, senderId, value: v });
			return { toast: { type: "info", content: "已收到" } };
		},
	});

	async function sendText(msg) {
		const content = JSON.stringify({ text: msg.text });
		if (msg.replyTo) {
			try {
				return ok(await client.im.v1.message.reply({ path: { message_id: msg.replyTo }, data: { msg_type: "text", content } }), "reply");
			} catch (e) {
				log("feishu_reply_fallback", { err: String(e?.message ?? e).slice(0, 160) }); // 原消息被撤回等 → 改为直接发
			}
		}
		return ok(
			await client.im.v1.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: msg.chatId, msg_type: "text", content } }),
			"create",
		);
	}

	async function sendStream(msg) {
		const key = msg.streamKey;
		let st = cards[key];
		if (st && st.text.length + msg.text.length > CARD_MAX) {
			// 卡片太长：收尾旧卡，开新卡
			await patch(st, true);
			st = null;
		}
		if (!st) {
			st = { messageId: null, text: msg.text, seqs: [msg.seq] };
			const content = JSON.stringify(card(st.text, { done: !!msg.final }));
			let res;
			if (msg.replyTo) {
				try {
					res = ok(await client.im.v1.message.reply({ path: { message_id: msg.replyTo }, data: { msg_type: "interactive", content } }), "reply_card");
				} catch (e) {
					log("feishu_reply_fallback", { err: String(e?.message ?? e).slice(0, 160) });
				}
			}
			res ??= ok(
				await client.im.v1.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: msg.chatId, msg_type: "interactive", content } }),
				"create_card",
			);
			st.messageId = res?.data?.message_id;
			cards[key] = st;
			saveCards();
			return;
		}
		if (st.seqs.includes(msg.seq)) {
			if (msg.final) await patch(st, true); // 重放：已拼进去了
			return;
		}
		st.text += msg.text;
		st.seqs.push(msg.seq);
		await patch(st, !!msg.final);
		saveCards();
	}

	// ---- 卡片版本：先试 2.0，被拒就退回 1.0 并记住 ----
	let cardV = Number(env.PIBOT_FEISHU_CARD_V || 2);
	async function createCard(chatId, build, purpose) {
		const t0 = Date.now();
		const tryOnce = async (v) =>
			ok(
				await client.im.v1.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(build(v)) } }),
				"create_card",
			);
		let res;
		try {
			res = await tryOnce(cardV);
		} catch (e) {
			if (cardV !== 2 || !/code=/.test(errStr(e))) throw new Error(errStr(e)); // 只在飞书明确拒收时退回 1.0
			log("feishu_card_v2_rejected", { err: errStr(e).slice(0, 200) });
			cardV = 1;
			res = await tryOnce(1);
		}
		log("feishu_card_create", { purpose, v: cardV, apiMs: Date.now() - t0 });
		return res?.data?.message_id;
	}
	async function patchCard(messageId, build, purpose, extra = {}) {
		const t0 = Date.now();
		try {
			ok(await client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(build(cardV)) } }), "patch_card");
		} catch (e) {
			throw new Error("patch_card " + errStr(e));
		}
		log("feishu_card_patch", { purpose, v: cardV, apiMs: Date.now() - t0, ...extra });
	}

	// 回答卡：msg.text 是这一张卡的「全量正文」（网关发快照，Outbox 会跳过被覆盖的旧快照）
	async function sendAnswer(msg) {
		const key = msg.cardKey;
		let st = cards[key] ?? { messageId: null, offset: 0 };
		if (!msg.text.trim()) return; // 从不撤回消息（撤回会在飞书里留下灰色的「撤回了一条消息」）
		let rest = msg.text.slice(st.offset);
		while (rest.length > CARD_MAX) {
			// 太长：当前卡写满、收尾，剩下的进下一张
			const head = rest.slice(0, CARD_MAX);
			if (st.messageId) await patchCard(st.messageId, (v) => answerCard(head, true, v), "card", { done: true, roll: true });
			else await createCard(msg.chatId, (v) => answerCard(head, true, v), "card");
			st = { messageId: null, offset: st.offset + CARD_MAX };
			rest = msg.text.slice(st.offset);
		}
		if (!st.messageId) st.messageId = await createCard(msg.chatId, (v) => answerCard(rest, !!msg.final, v), "card");
		else await patchCard(st.messageId, (v) => answerCard(rest, !!msg.final, v), "card", { done: !!msg.final, chars: rest.length });
		cards[key] = st;
		saveCards();
	}

	async function sendApproval(msg) {
		const key = "approval:" + msg.approvalId;
		const st = cards[key];
		const reuse = msg.reuseCardKey && cards[msg.reuseCardKey]?.messageId;
		if (!st?.messageId && reuse) {
			// 「…」占位卡原地变成审批卡
			await patchCard(reuse, (v) => approvalCard(msg, v), "approval", { state: msg.state, reused: true });
			cards[key] = { messageId: reuse, offset: 0 };
			delete cards[msg.reuseCardKey];
			saveCards();
		} else if (!st?.messageId) {
			const id = await createCard(msg.chatId, (v) => approvalCard(msg, v), "approval");
			cards[key] = { messageId: id, offset: 0 };
			saveCards();
		} else await patchCard(st.messageId, (v) => approvalCard(msg, v), "approval", { state: msg.state });
	}

	async function sendModeCard(msg) {
		const key = "mode:" + msg.modeCardId;
		const st = cards[key];
		if (!st?.messageId) {
			const id = await createCard(msg.chatId, (v) => modeCard(msg, v), "mode");
			cards[key] = { messageId: id, offset: 0 };
			saveCards();
		} else await patchCard(st.messageId, (v) => modeCard(msg, v), "mode", { mode: msg.mode });
	}

	// 测试卡：直接按 open_id 发给主人（scripts/feishu-test-card.mjs 也可单独跑）
	async function sendTestCard(openId) {
		const build = (v) =>
			v === 1
				? { config: { wide_screen_mode: true, update_multi: true }, elements: [{ tag: "markdown", content: "这是一张测试卡片。点一下下面的按钮，我这边收到回调就说明卡片按钮是通的。" }, { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "点我试试" }, type: "primary", value: { pibot: "ping" } }] }] }
				: { schema: "2.0", config: { update_multi: true }, body: { elements: [{ tag: "markdown", content: "这是一张测试卡片。点一下下面的按钮，我这边收到回调就说明卡片按钮是通的。" }, { tag: "button", text: { tag: "plain_text", content: "点我试试" }, type: "primary_filled", behaviors: [{ type: "callback", value: { pibot: "ping" } }] }] } };
		const t0 = Date.now();
		const res = ok(await client.im.v1.message.create({ params: { receive_id_type: "open_id" }, data: { receive_id: openId, msg_type: "interactive", content: JSON.stringify(build(cardV)) } }), "test_card");
		const messageId = res?.data?.message_id;
		log("feishu_test_card", { v: cardV, apiMs: Date.now() - t0, ok: !!messageId });
		// 回读：确认服务端存下的是 interactive 卡片
		let readBack = null;
		try {
			const g = await client.im.v1.message.get({ path: { message_id: messageId } });
			readBack = g?.data?.items?.[0]?.msg_type ?? null;
		} catch (e) {
			readBack = "get_failed: " + String(e?.message ?? e).slice(0, 80);
		}
		return { ok: !!messageId, v: cardV, readBack, messageId };
	}

	async function patch(st, done) {
		if (!st.messageId) return;
		ok(
			await client.im.v1.message.patch({ path: { message_id: st.messageId }, data: { content: JSON.stringify(card(st.text, { done })) } }),
			"patch",
		);
	}

	let ws = null;
	let stopped = false;
	let rebuildTimer = null;
	function connect() {
		if (stopped) return;
		setState("connecting");
		ws = new lark.WSClient({
			appId,
			appSecret,
			domain,
			loggerLevel: lark.LoggerLevel.warn,
			autoReconnect: true,
			onReady: () => setState("connected"),
			onReconnecting: () => {
				status.reconnects++;
				setState("reconnecting", { reconnects: status.reconnects });
			},
			onReconnected: () => setState("connected"),
			onError: (err) => {
				setState("failed", { lastError: String(err?.message ?? err).slice(0, 200) });
				// SDK 放弃了（凭证错 / 重试耗尽）→ 15s 后整体重建，保证长连接尽量在线
				clearTimeout(rebuildTimer);
				rebuildTimer = setTimeout(() => {
					try {
						ws?.close?.();
					} catch {}
					connect();
				}, 15_000);
			},
		});
		Promise.resolve(ws.start({ eventDispatcher: dispatcher })).catch((e) => setState("failed", { lastError: String(e?.message ?? e).slice(0, 200) }));
	}

	return {
		name: "feishu",
		streaming: true,
		onInbound: (fn) => (onInbound = fn),
		onCardAction: (fn) => (onCardAction = fn),
		status: () => ({ ...status, since: new Date(status.since).toISOString(), lastEventAt: status.lastEventAt && new Date(status.lastEventAt).toISOString() }),
		sendTestCard,
		async send(msg) {
			if (msg.purpose === "card" && msg.cardKey) return sendAnswer(msg);
			if (msg.purpose === "approval" && msg.approvalId) return sendApproval(msg);
			if (msg.purpose === "mode_card" && msg.modeCardId) return sendModeCard(msg);
			if (msg.purpose === "stream" && msg.streamKey) return sendStream(msg);
			return sendText(msg);
		},
		start() {
			connect();
		},
		stop() {
			stopped = true;
			clearTimeout(rebuildTimer);
			try {
				ws?.close?.();
			} catch {}
		},
	};
}
