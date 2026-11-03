#!/usr/bin/env node
// 本地通道小工具（模拟飞书里的你）：
//   node gateway/cli.mjs send <chatId> <text>
//   node gateway/cli.mjs watch <chatId>      # 实时看机器人回复（带上海时间戳）
//   node gateway/cli.mjs health | down | up
import { cst } from "./util.mjs";
const base = `http://127.0.0.1:${process.env.PIBOT_LOCAL_PORT || 8787}`;
const [cmd, chatId, ...rest] = process.argv.slice(2);
if (cmd === "send") {
	const r = await fetch(`${base}/inbound`, { method: "POST", body: JSON.stringify({ chatId, text: rest.join(" ") }) });
	console.log(`[${cst()}] 你 → ${chatId}: ${rest.join(" ")}\n  ${await r.text()}`);
} else if (cmd === "watch") {
	const r = await fetch(`${base}/events?chatId=${encodeURIComponent(chatId)}`);
	const dec = new TextDecoder();
	let buf = "";
	for await (const chunk of r.body) {
		buf += dec.decode(chunk, { stream: true });
		let i;
		while ((i = buf.indexOf("\n\n")) >= 0) {
			const block = buf.slice(0, i);
			buf = buf.slice(i + 2);
			if (!block.startsWith("data: ")) continue;
			const m = JSON.parse(block.slice(6));
			console.log(`[${m.deliveredAt}] bot#${m.seq} (${m.purpose}): ${m.text}`);
		}
	}
} else if (cmd === "health") {
	console.log(await (await fetch(`${base}/health`)).text());
} else if (cmd === "down" || cmd === "up") {
	console.log(await (await fetch(`${base}/channel/${cmd}`, { method: "POST" })).text());
} else {
	console.log("usage: cli.mjs send|watch <chatId> [text] | health | down | up");
}
