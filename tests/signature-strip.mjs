// 飞书出站兜底：去掉结尾的「—— AI之境」落款，正文里的「AI之境」不动。用法：node tests/signature-strip.mjs
import { stripSignatureText as s } from "../gateway/channels/feishu.mjs";
const cases = [
	["K哥，在杭州，讨厌香菜。—— AI之境", true, "K哥，在杭州，讨厌香菜。"],
	["记住了，K哥。\n\n—— AI之境", true, "记住了，K哥。"],
	["文件内容是「你好 AI之境」", true, "文件内容是「你好 AI之境」"],
	["每行末尾加『AI之境』", true, "每行末尾加『AI之境』"],
	["好的\n\n—— AI", false, "好的"], // 回答卡流式中途：半截落款先藏起来
	["正文——中间破折号继续", false, "正文——中间破折号继续"],
	["a — b", true, "a — b"],
];
let bad = 0;
for (const [t, final, want] of cases) {
	const got = s(t, final);
	if (got !== want) bad++, console.log("✗", JSON.stringify(t), "→", JSON.stringify(got), "期望", JSON.stringify(want));
}
console.log(bad ? `${bad} 个失败` : `全部 ${cases.length} 个通过`);
process.exit(bad ? 1 : 0);
