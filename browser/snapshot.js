// 注入到页面（每个 frame）里执行：把页面变成「带编号的可读文本」，给模型看。
// 可交互元素打上 data-pi-ref，后续点击/输入按编号找回；密码框和用密码库填过的框只显示「已填」。
// 由 extensions/browser.ts 读取后 page.evaluate 执行。公众号「AI之境」
(prefix) => {
	const W = window;
	W.__piN = W.__piN || 0;
	const lines = [];
	let buf = [];
	const clip = (s, n = 80) => {
		s = String(s ?? "").replace(/\s+/g, " ").trim();
		return s.length > n ? s.slice(0, n - 1) + "…" : s;
	};
	const flush = () => {
		const t = clip(buf.join(" "), 400);
		if (t) lines.push(t);
		buf = [];
	};
	const visible = (el) => {
		try {
			if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
		} catch {}
		const s = getComputedStyle(el);
		if (s.display === "contents") return true;
		const r = el.getBoundingClientRect();
		return (r.width > 1 && r.height > 1) || el.tagName === "OPTION";
	};
	const STD = 'a[href],button,input,select,textarea,summary,[contenteditable="true"],[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox]';
	const interactive = (el) => {
		if (el.matches(STD)) return !(el.tagName === "INPUT" && el.type === "hidden");
		if (el.hasAttribute("onclick")) return true;
		const s = getComputedStyle(el);
		if (s.cursor === "pointer" && !(el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer") && !el.querySelector(STD)) {
			const t = (el.innerText || "").trim();
			return t.length > 0 && t.length < 60;
		}
		return false;
	};
	const ref = (el) => {
		let r = el.getAttribute("data-pi-ref");
		if (!r || !r.startsWith(prefix)) {
			r = prefix + ++W.__piN;
			el.setAttribute("data-pi-ref", r);
		}
		return r;
	};
	const labelOf = (el) => {
		const aria = el.getAttribute("aria-label");
		if (aria) return clip(aria);
		if (el.labels && el.labels[0]) return clip(el.labels[0].innerText);
		const lb = el.getAttribute("aria-labelledby");
		if (lb) {
			const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" ");
			if (t.trim()) return clip(t);
		}
		return "";
	};
	const describe = (el) => {
		const r = ref(el);
		const tag = el.tagName.toLowerCase();
		const role = el.getAttribute("role");
		const dis = el.disabled || el.getAttribute("aria-disabled") === "true" ? "（不可用）" : "";
		if (tag === "input" || tag === "textarea" || role === "textbox" || role === "searchbox" || el.isContentEditable) {
			const type = (el.type || "text").toLowerCase();
			if (type === "checkbox" || type === "radio") return `[${r}] ${type === "checkbox" ? "勾选框" : "单选"}${el.checked ? "☑" : "☐"}「${labelOf(el) || clip(el.value, 40)}」${dis}`;
			if (["submit", "button", "reset", "image"].includes(type)) return `[${r}] 按钮「${clip(el.value || labelOf(el) || el.alt || type)}」${dis}`;
			const secret = type === "password" || el.getAttribute("data-pi-secret") === "1";
			const v = el.isContentEditable && tag !== "input" && tag !== "textarea" ? el.innerText : el.value;
			const val = v ? (secret ? "（已填，内容隐藏）" : `值「${clip(v, 60)}」`) : "";
			const ph = el.placeholder ? `提示「${clip(el.placeholder, 40)}」` : "";
			const nm = labelOf(el) || (el.name ? clip(el.name, 30) : "") || (el.id ? clip(el.id, 30) : "");
			return `[${r}] 输入框(${type === "password" ? "密码" : type})${nm ? "「" + nm + "」" : ""} ${ph} ${val}${dis}`.replace(/\s+/g, " ").trim();
		}
		if (tag === "select") {
			const opts = [...el.options].slice(0, 20).map((o) => clip(o.text, 24));
			const cur = el.selectedOptions[0]?.text ?? "";
			return `[${r}] 下拉框「${labelOf(el) || el.name || ""}」当前「${clip(cur, 30)}」可选：${opts.join(" / ")}${el.options.length > 20 ? " …" : ""}${dis}`;
		}
		const text = clip(el.innerText || labelOf(el) || el.title || el.querySelector("img")?.alt || el.value || "", 80);
		if (tag === "a") {
			let href = el.getAttribute("href") || "";
			try {
				const u = new URL(href, location.href);
				href = u.origin === location.origin ? u.pathname + u.search : u.host + u.pathname;
			} catch {}
			return `[${r}] 链接「${text || "(无文字)"}」→ ${clip(href, 70)}`;
		}
		if (role === "checkbox" || role === "switch") return `[${r}] 勾选框${el.getAttribute("aria-checked") === "true" ? "☑" : "☐"}「${text || labelOf(el)}」${dis}`;
		if (role === "tab" || role === "option" || role === "menuitem") return `[${r}] ${role === "tab" ? "标签页" : "选项"}「${text}」${el.getAttribute("aria-selected") === "true" ? "（当前）" : ""}`;
		if (!text) {
			// 没文字的开关/图标按钮：借旁边的文字当名字（如设置页一行「Phone [开关]」）
			for (let a = el.parentElement, i = 0; a && i < 3; a = a.parentElement, i++) {
				const t = clip(a.innerText, 40);
				if (t) return `[${r}] ${role === "switch" ? "开关" : "按钮"}「(无文字)」旁边写着「${t}」${dis}`;
			}
		}
		return `[${r}] 按钮「${text || "(无文字)"}」${dis}`;
	};
	const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "IFRAME", "OBJECT", "CANVAS"]);
	const BLOCK = /^(DIV|P|LI|UL|OL|TR|TABLE|SECTION|ARTICLE|HEADER|FOOTER|NAV|MAIN|ASIDE|FORM|DL|DT|DD|H[1-6]|BR|HR|FIGURE|BLOCKQUOTE|PRE|TD|TH)$/;
	let count = 0;
	const walk = (node) => {
		if (count++ > 20000) return;
		if (node.nodeType === 3) {
			const t = node.textContent.replace(/\s+/g, " ").trim();
			if (t) buf.push(t);
			return;
		}
		if (node.nodeType !== 1) return;
		const el = node;
		if (SKIP.has(el.tagName)) return;
		if (el.tagName === "svg" || el.tagName === "SVG") return;
		if (!visible(el)) return;
		if (interactive(el)) {
			flush();
			lines.push(describe(el));
			return;
		}
		if (el.tagName === "IMG") {
			if (el.alt && el.alt.length > 1) buf.push(`[图:${clip(el.alt, 40)}]`);
			return;
		}
		const block = BLOCK.test(el.tagName);
		if (block) flush();
		const h = /^H([1-6])$/.exec(el.tagName);
		if (h) {
			const t = clip(el.innerText, 120);
			if (t && !el.querySelector(STD)) {
				lines.push("#".repeat(Number(h[1])) + " " + t);
				return;
			}
		}
		if (el.tagName === "TD" || el.tagName === "TH") buf.push("|");
		for (const c of el.childNodes) walk(c);
		if (el.shadowRoot) for (const c of el.shadowRoot.childNodes) walk(c);
		if (block) flush();
	};
	if (document.body) walk(document.body);
	flush();
	// 相邻重复行去掉
	const out = [];
	for (const l of lines) if (l !== out[out.length - 1]) out.push(l);
	const se = document.scrollingElement || document.documentElement;
	const pct = se.scrollHeight > innerHeight ? Math.round(((se.scrollTop + innerHeight) / se.scrollHeight) * 100) : 100;
	return { lines: out, scrollPct: pct, title: document.title };
}
