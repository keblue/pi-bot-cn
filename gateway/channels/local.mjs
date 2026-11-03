// 本地测试通道：只监听 127.0.0.1，用来在没有飞书凭证时模拟「同一 chatId 连发消息」。
// POST /inbound {chatId,text}      → 进网关
// GET  /events?chatId=xxx          → SSE，实时看机器人发出的消息
// POST /channel/down | /channel/up → 模拟 IM 通道故障（标志落盘，重启后仍在）
// GET  /health                     → 健康检查
// 投递 = 追加到 data/channel-local/<chatId>.jsonl（相当于「用户手机收到了」）
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cst, safeId } from "../util.mjs";

export function createLocalChannel({ dataDir, port, log }) {
	const dir = join(dataDir, "channel-local");
	mkdirSync(dir, { recursive: true });
	const downFlag = join(dir, "DOWN");
	const listeners = new Map(); // chatId -> Set(res)
	let onInbound = null;
	let healthFn = () => ({ ok: true });

	const channel = {
		name: "local",
		streaming: true, // 本地通道支持分段流式
		onInbound: (fn) => (onInbound = fn),
		setHealth: (fn) => (healthFn = fn),
		async send(msg) {
			if (existsSync(downFlag)) throw new Error("local channel DOWN (simulated)");
			const rec = { deliveredAt: cst(), ...msg };
			appendFileSync(join(dir, safeId(msg.chatId) + ".jsonl"), JSON.stringify(rec) + "\n");
			for (const res of listeners.get(msg.chatId) ?? []) res.write(`data: ${JSON.stringify(rec)}\n\n`);
		},
		start() {
			const server = createServer(async (req, res) => {
				const url = new URL(req.url, "http://127.0.0.1");
				try {
					if (req.method === "GET" && url.pathname === "/health") {
						const h = await healthFn();
						res.writeHead(h.ok ? 200 : 503, { "content-type": "application/json" });
						return res.end(JSON.stringify(h));
					}
					if (req.method === "GET" && url.pathname === "/events") {
						const chatId = url.searchParams.get("chatId");
						res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
						res.write(": ok\n\n");
						if (!listeners.has(chatId)) listeners.set(chatId, new Set());
						listeners.get(chatId).add(res);
						req.on("close", () => listeners.get(chatId)?.delete(res));
						return;
					}
					if (req.method === "POST" && url.pathname === "/channel/down") {
						writeFileSync(downFlag, cst());
						log("channel_down", {});
						res.writeHead(200);
						return res.end("down\n");
					}
					if (req.method === "POST" && url.pathname === "/channel/up") {
						rmSync(downFlag, { force: true });
						log("channel_up", {});
						channel.onUp?.();
						res.writeHead(200);
						return res.end("up\n");
					}
					if (req.method === "POST" && url.pathname === "/inbound") {
						let body = "";
						for await (const c of req) body += c;
						const { chatId, text, senderId } = JSON.parse(body);
						const receivedAt = Date.now();
						const r = await onInbound({ channel: "local", chatId, senderId: senderId ?? "local-owner", text, receivedAt });
						res.writeHead(200, { "content-type": "application/json" });
						return res.end(JSON.stringify({ receivedAt: cst(receivedAt), ...r }));
					}
					res.writeHead(404);
					res.end();
				} catch (e) {
					res.writeHead(500);
					res.end(String(e?.message ?? e));
				}
			});
			server.listen(port, "127.0.0.1", () => log("local_channel_listen", { addr: `127.0.0.1:${port}` }));
			channel.server = server;
		},
		stop() {
			channel.server?.close();
		},
	};
	return channel;
}
