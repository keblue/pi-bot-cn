#!/usr/bin/env bash
# pi-bot-cn install skeleton — safe checks + next steps only.
# Does not download packages that would fail offline beyond command existence checks.
# Never prints secret file contents.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "==> pi-bot-cn install (0.0.1 skeleton)"
echo "    由微信公众号「AI之境」设计与维护"
echo

if [[ "$(id -u)" -eq 0 ]]; then
  echo "错误：请不要用 root 运行。请切换到普通用户后再执行。"
  exit 1
fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    echo "警告：当前系统 ID=${ID:-unknown}，文档按 Ubuntu 24.04 编写，可继续但未充分测试。"
  else
    echo "系统：Ubuntu ${VERSION_ID:-?} (${PRETTY_NAME:-})"
  fi
else
  echo "警告：读不到 /etc/os-release，跳过发行版检查。"
fi

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令：$1"
    return 1
  fi
  echo "已找到：$1 ($("$1" --version 2>/dev/null | head -n1 || echo ok))"
}

MISSING=0
for c in git curl bash; do
  need_cmd "$c" || MISSING=1
done

if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v 2>/dev/null || true)"
  echo "Node：${NODE_VER}"
  # pi 需要 Node >= 22.19；此处只提示，不强制失败，便于骨架阶段排查
  echo "提示：正式环境请使用 Node.js ≥ 22.19（建议 24.x）。可用 npmmirror 或 NodeSource 安装。"
else
  echo "未找到 node。请先安装 Node.js ≥ 22.19，再重新运行本脚本。"
  MISSING=1
fi

if command -v pi >/dev/null 2>&1; then
  echo "已找到 pi：$(command -v pi)"
else
  echo "未找到 pi 命令。请先按 https://pi.dev 安装 @earendil-works/pi-coding-agent（建议锁 1.5.x）。"
fi

echo
if [[ "$MISSING" -ne 0 ]]; then
  echo "基础命令不齐，已停止。补齐后重跑：bash install.sh"
  exit 1
fi

echo "骨架阶段：尚未自动安装第三方 npm/pip 包（避免离线失败）。"
echo "下一步请你（或 agent）按顺序做："
echo "  1. 阅读 README.md 与 docs/ATTRIBUTION.md，按锁定版本安装依赖（后续提供 config/deps.lock.json）。"
echo "  2. 复制 config 模板（后续）到 ~/.config/pi-bot-cn/，chmod 600 环境文件，自行填写密钥——脚本不会回显。"
echo "  3. 按 docs（飞书建应用教程，后续）创建应用：长连接、收消息 + 卡片回调。"
echo "  4. 运行：bash doctor.sh"
echo "  5. 配对白名单，确认 08:00 早报 / 22:00 复盘计划。"
echo
echo "仓库：https://github.com/keblue/pi-bot-cn"
echo "完成骨架检查。未写入任何密钥。"
