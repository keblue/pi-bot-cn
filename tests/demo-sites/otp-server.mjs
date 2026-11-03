#!/usr/bin/env node
// 「喵喵银行」——本地假网站，测试「登录墙 → 机器人问主人要短信验证码」。只监听 127.0.0.1。
// 点「获取验证码」后，验证码写进 /tmp/otp-code.txt（模拟短信发到主人手机上），测试脚本读它，假装主人在飞书里回给机器人。
// 用法：node tests/demo-sites/otp-server.mjs [端口，默认 8798]    公众号「AI之境」
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const PORT = Number(process.argv[2] || process.env.OTP_PORT || 8798);
const CODE_FILE = process.env.OTP_CODE_FILE || "/tmp/otp-code.txt";
const sessions = new Map(); // sid -> {phone, code, ok}
const css = `body{font-family:"Noto Sans CJK SC",sans-serif;background:#fff5f8;margin:0}.box{max-width:420px;margin:60px auto;background:#fff;border-radius:16px;padding:32px;box-shadow:0 6px 24px #f3b4c855}
h1{color:#e05a87;margin:0 0 6px}p.s{color:#888;margin:0 0 24px}label{display:block;margin:14px 0 6px;color:#555}input{width:100%;box-sizing:border-box;padding:12px;font-size:17px;border:1px solid #ddd;border-radius:8px}
button{margin-top:16px;padding:12px 18px;font-size:16px;border:0;border-radius:8px;background:#e05a87;color:#fff;cursor:pointer}button.sec{background:#fbd3e0;color:#a33}.row{display:flex;gap:8px;align-items:end}.row input{flex:1}
.err{color:#d33;margin-top:10px}.big{font-size:40px;color:#e05a87;margin:8px 0}.tip{background:#fff0d9;padding:10px;border-radius:8px;color:#a66;font-size:14px}`;
const page = (body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>喵喵银行 · 网上银行</title><style>${css}</style></head><body><div class="box">${body}</div></body></html>`;
const sidOf = (req) => /sid=(\w+)/.exec(req.headers.cookie || "")?.[1];

createServer(async (req, res) => {
	const url = new URL(req.url, "http://127.0.0.1");
	let sid = sidOf(req);
	if (!sid || !sessions.has(sid)) {
		sid = Math.random().toString(36).slice(2);
		sessions.set(sid, {});
		res.setHeader("set-cookie", `sid=${sid}; Path=/; HttpOnly`);
	}
	const s = sessions.get(sid);
	let body = "";
	for await (const c of req) body += c;
	const form = Object.fromEntries(new URLSearchParams(body));
	const html = (h, code = 200) => (res.writeHead(code, { "content-type": "text/html; charset=utf-8" }), res.end(page(h)));
	const go = (to) => (res.writeHead(302, { location: to }), res.end());

	if (url.pathname === "/" || url.pathname === "/login") {
		if (s.ok) return go("/account");
		return html(`<h1>🐱 喵喵银行</h1><p class="s">全球第一家只收小鱼干的银行</p>
<form method="post" action="/send"><label for="phone">手机号</label><div class="row"><input id="phone" name="phone" placeholder="请输入手机号" value="${s.phone ?? ""}"><button class="sec">获取验证码</button></div></form>
<form method="post" action="/verify"><label for="code">短信验证码</label><input id="code" name="code" placeholder="6 位数字" maxlength="6" inputmode="numeric"><button>登录</button>
${url.searchParams.get("err") ? `<div class="err">验证码不对哦，喵~</div>` : ""}${s.code ? `<p class="tip">验证码已发送到 ${String(s.phone).replace(/(\d{3})\d+(\d{4})/, "$1****$2")}，5 分钟内有效</p>` : ""}</form>`);
	}
	if (url.pathname === "/send" && req.method === "POST") {
		s.phone = (form.phone || "").replace(/\D/g, "") || "13800138000";
		s.code = String(Math.floor(100000 + Math.random() * 900000));
		writeFileSync(CODE_FILE, s.code); // 「短信」
		return go("/login");
	}
	if (url.pathname === "/verify" && req.method === "POST") {
		if (s.code && form.code === s.code) {
			s.ok = true;
			return go("/account");
		}
		return go("/login?err=1");
	}
	if (url.pathname === "/account") {
		if (!s.ok) return go("/login");
		return html(`<h1>🐱 欢迎回来</h1><p class="s">尾号 ${String(s.phone).slice(-4)} 的铲屎官</p>
<div>活期余额</div><div class="big">¥3.50</div><div>另有存货：<b>17 根猫条</b>、<b>2 袋冻干</b></div>
<p class="tip">温馨提示：本月猫粮支出已超预算 380%，建议主子节制。</p>
<h3>最近交易</h3><table><tr><td>11-02</td><td>进口三文鱼冻干</td><td>-¥128.00</td></tr><tr><td>11-01</td><td>逗猫棒（第 9 根）</td><td>-¥19.90</td></tr><tr><td>10-31</td><td>工资</td><td>+¥150.00</td></tr></table>`);
	}
	res.writeHead(404);
	res.end("not found");
}).listen(PORT, "127.0.0.1", () => console.log(`喵喵银行 http://127.0.0.1:${PORT}`));
