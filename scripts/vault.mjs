#!/usr/bin/env node
// 密码库小工具：在服务器上（SSH 里）存/删/列登录信息，密码输入不回显，也不经过聊天和模型。
// 文件：~/.config/pi-bot-cn/vault.json（权限 600）。机器人只能用 browser_fill_secret 按名字填，看不到值。
//   node scripts/vault.mjs list
//   node scripts/vault.mjs set <名字> <网站域名> [字段=值 ...]   没给的 username/password 会交互式询问（密码不回显）
//   node scripts/vault.mjs rm <名字>
// 例：node scripts/vault.mjs set saucedemo saucedemo.com username=standard_user   （然后输入密码）
// 公众号「AI之境」
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const FILE = process.env.PIBOT_VAULT || join(homedir(), ".config/pi-bot-cn/vault.json");
const load = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8") || "{}") : {});
const save = (v) => {
	mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
	writeFileSync(FILE, JSON.stringify(v, null, 1) + "\n", { mode: 0o600 });
	chmodSync(FILE, 0o600);
};
function ask(q, hidden) {
	return new Promise((res) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		if (hidden) rl._writeToOutput = (s) => rl.output.write(s.startsWith(q) ? q : s.includes("\n") ? "\n" : "");
		rl.question(q, (a) => (rl.close(), res(a)));
	});
}
const [cmd, name, site, ...kv] = process.argv.slice(2);
const v = load();
if (cmd === "list" || !cmd) {
	for (const [k, e] of Object.entries(v)) console.log(`${k}\t${e.site ?? "-"}\t${Object.keys(e.fields ?? {}).join(",")}`);
	if (!Object.keys(v).length) console.log("（空）");
} else if (cmd === "set" && name && site) {
	const fields = { ...(v[name]?.fields ?? {}) };
	for (const p of kv) {
		const i = p.indexOf("=");
		if (i > 0) fields[p.slice(0, i)] = p.slice(i + 1);
	}
	if (!fields.username && process.stdin.isTTY) fields.username = await ask("用户名：", false);
	if (!fields.password && process.stdin.isTTY) fields.password = await ask("密码（不显示）：", true);
	v[name] = { site, fields };
	save(v);
	console.log(`已保存「${name}」（${site}），字段：${Object.keys(fields).join(", ")}`);
} else if (cmd === "rm" && name) {
	delete v[name];
	save(v);
	console.log(`已删除「${name}」`);
} else {
	console.log("用法：node scripts/vault.mjs list | set <名字> <网站域名> [字段=值 ...] | rm <名字>");
	process.exit(1);
}
