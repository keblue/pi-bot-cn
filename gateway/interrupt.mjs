// 连发消息意图粗分：cancel | redirect | followUp | steer（默认）
// 规则来自 config/interrupt-policy.json，可改。
export function loadPolicy(raw) {
	const p = JSON.parse(raw);
	const re = (arr) => (arr ?? []).map((s) => new RegExp(s, "i"));
	return { ...p, _cancel: re(p.cancelPatterns), _redirect: re(p.redirectPatterns), _followUp: re(p.followUpPatterns) };
}

export function classify(policy, text) {
	const t = text.trim();
	if (t.length <= (policy.cancelMaxLength ?? 12) && policy._cancel.some((r) => r.test(t))) return "cancel";
	if (policy._redirect.some((r) => r.test(t))) return "redirect";
	if (policy._followUp.some((r) => r.test(t))) return "followUp";
	return policy.defaultWhileBusy ?? "steer";
}
