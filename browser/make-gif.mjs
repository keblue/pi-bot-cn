#!/usr/bin/env node
// 把一次浏览器会话的录屏帧（CDP screencast 的 jpg + 时间戳）合成 GIF，目标 1–2MB。
// 用法：node browser/make-gif.mjs <录像目录>   （目录里有 frames/ 和 frames.txt）
// 停顿太久的帧压缩到 1.2 秒，整段超过 45 秒就等比快进；超过 2MB 自动降分辨率/帧率再来。公众号「AI之境」
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir || !existsSync(join(dir, "frames.txt"))) {
	console.error("用法：node browser/make-gif.mjs <录像目录>");
	process.exit(1);
}
const rows = readFileSync(join(dir, "frames.txt"), "utf8").trim().split("\n").filter(Boolean).map((l) => {
	const [file, ts] = l.split(" ");
	return { file: join(dir, "frames", file), ts: Number(ts) };
}).filter((r) => existsSync(r.file));
if (rows.length < 2) {
	console.error("帧太少，不生成 GIF");
	process.exit(2);
}
let durs = rows.map((r, i) => (i < rows.length - 1 ? (rows[i + 1].ts - r.ts) / 1000 : 2));
durs = durs.map((d) => Math.min(Math.max(d, 0.06), 1.2));
const total = durs.reduce((a, b) => a + b, 0);
const MAX_T = Number(process.env.GIF_MAX_SECONDS || 45);
if (total > MAX_T) durs = durs.map((d) => d * (MAX_T / total));
const list = join(dir, "frames.concat");
writeFileSync(list, rows.map((r, i) => `file '${r.file}'\nduration ${durs[i].toFixed(3)}`).join("\n") + `\nfile '${rows.at(-1).file}'\n`);
const out = join(dir, "session.gif");
const LIMIT = Number(process.env.GIF_MAX_BYTES || 2_000_000);
const tries = [
	{ w: 800, fps: 8, colors: 128 },
	{ w: 720, fps: 6, colors: 96 },
	{ w: 640, fps: 5, colors: 64 },
	{ w: 560, fps: 4, colors: 48 },
	{ w: 480, fps: 3, colors: 32 },
];
let size = 0, used;
for (const t of tries) {
	const vf = `fps=${t.fps},scale=${t.w}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${t.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
	execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", vf, "-loop", "0", out]);
	size = statSync(out).size;
	used = t;
	if (size <= LIMIT) break;
}
try { unlinkSync(list); } catch {}
const info = { gif: out, bytes: size, frames: rows.length, seconds: Math.round(durs.reduce((a, b) => a + b, 0) * 10) / 10, ...used };
writeFileSync(join(dir, "gif.json"), JSON.stringify(info, null, 1));
console.log(JSON.stringify(info));
