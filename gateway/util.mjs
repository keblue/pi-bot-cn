// 小工具：上海时区时间戳 + JSONL 日志（绝不记录密钥）
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function cst(ts = Date.now()) {
	const d = new Date(ts + 8 * 3600_000);
	return d.toISOString().replace("T", " ").replace("Z", "+08:00");
}

export function makeLogger(file) {
	mkdirSync(dirname(file), { recursive: true });
	return (event, fields = {}) => {
		const rec = { t: cst(), ms: Date.now(), event, ...fields };
		const line = JSON.stringify(rec);
		try {
			appendFileSync(file, line + "\n");
		} catch {}
		if (process.env.PIBOT_LOG_STDOUT !== "0") console.log(line);
	};
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function safeId(s) {
	return String(s).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[^A-Za-z0-9]+/, "c").slice(0, 80) || "chat";
}
