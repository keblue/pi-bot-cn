// 飞书通道（一等公民）：只走长连接（WSClient），不对公网开任何端口。
// - 收消息：im.message.receive_v1（文本 / 富文本 post）
// - 卡片回调：card.action.trigger（同一条长连接；流式卡片上的「停止」按钮 → 网关按「停」处理）
// - 发消息：im.v1.message.reply（回复主人那条消息）/ im.v1.message.create（主动发）
// - 流式：同一轮回答先发一张 interactive 卡片，后续用 im.v1.message.patch 原地更新（网关已节流 ≥1.2s/次，远低于 5 QPS）
// - 只有 PI_BOT_OWNER_OPEN_IDS 白名单里的人能触发模型（Gate 在进模型之前）；白名单为空时只记录日志并放行私聊。
// - 环境里出现 FEISHU_APP_ID/SECRET 即自动启用；连接断了 SDK 自动重连，SDK 放弃后我们 15s 后整体重建。
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const CARD_MAX = 9000; // 单卡正文上限（飞书卡片 ~30KB，留足余量）

function card(text, { done, title }) {
	const elements = [{ tag: "markdown", content: text || "…" }];
	if (!done)
		elements.push({
			tag: "action",
			actions: [{ tag: "button", text: { tag: "plain_text", content: "停止" }, type: "danger", value: { pibot: "stop" } }],
		});
	return {
		config: { wide_screen_mode: true, update_multi: true },
		header: title ? { template: done ? "green" : "blue", title: { tag: "plain_text", content: title } } : undefined,
		elements,
	};
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
				return { toast: { type: "info", content: "正在停止…" } };
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
		async send(msg) {
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
