#!/usr/bin/env bash
# pi-bot-cn doctor — self-check skeleton. Never prints secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ok()   { echo "[通过] $*"; }
warn() { echo "[注意] $*"; }
fail() { echo "[失败] $*"; FAIL=1; }

FAIL=0

echo "==> pi-bot-cn doctor (0.0.1 skeleton)"
echo

if [[ "$(id -u)" -eq 0 ]]; then
  fail "当前是 root。请用普通用户运行管家。"
else
  ok "运行用户：$(id -un)（非 root）"
fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  ok "系统：${PRETTY_NAME:-$ID}"
else
  warn "无法读取 /etc/os-release"
fi

if command -v node >/dev/null 2>&1; then
  ok "Node：$(node -v)"
else
  fail "未安装 Node.js（需要 ≥ 22.19）"
fi

if command -v pi >/dev/null 2>&1; then
  ok "pi 在 PATH 中：$(command -v pi)"
else
  warn "未找到 pi（安装完成前属正常）"
fi

for c in git curl; do
  if command -v "$c" >/dev/null 2>&1; then
    ok "命令 $c 可用"
  else
    fail "缺少 $c"
  fi
done

# Env file presence only — never cat contents
ENV_CANDIDATES=(
  "${HOME}/.config/pi-bot-cn/env"
  "${HOME}/.config/pi-duet/env"
)
FOUND_ENV=0
for f in "${ENV_CANDIDATES[@]}"; do
  if [[ -f "$f" ]]; then
    FOUND_ENV=1
    PERM="$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f" 2>/dev/null || echo '?')"
    if [[ "$PERM" == "600" || "$PERM" == "400" ]]; then
      ok "密钥文件存在且权限为 ${PERM}（不显示内容）：$f"
    else
      fail "密钥文件权限应为 600，当前 ${PERM}：$f"
    fi
    # Count non-empty assignment lines without printing values
    FILLED="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$f" 2>/dev/null | grep -cvE '=$|=""$|='"'"''"'"'$' || true)"
    ok "密钥文件中疑似已填写的变量行数：${FILLED}（仅计数）"
  fi
done
if [[ "$FOUND_ENV" -eq 0 ]]; then
  warn "尚未发现 env 文件（安装未完成前属正常）"
fi

# Listening ports hint — informational
if command -v ss >/dev/null 2>&1; then
  warn "请人工确认：除 SSH 外尽量不要对公网开放业务端口（飞书走长连接）。"
elif command -v netstat >/dev/null 2>&1; then
  warn "请人工确认：除 SSH 外尽量不要对公网开放业务端口（飞书走长连接）。"
fi

echo
if [[ "$FAIL" -ne 0 ]]; then
  echo "自检未全部通过。修完后重跑：bash doctor.sh"
  exit 1
fi
echo "骨架自检通过。完整连通性（DeepSeek / 飞书长连接 / 审批卡片）将在实现期加入。"
