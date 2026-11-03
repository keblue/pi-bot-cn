#!/usr/bin/env bash
# pi-bot-cn「自己的浏览器」：虚拟屏幕 Xvfb + 真 Chromium（有界面模式，录屏/接管都靠它）
# - 调试端口只绑 127.0.0.1（不对公网开放）；登录状态存在持久 profile 里，重启不丢
# - 由 systemd 单元 pi-bot-cn-browser.service 常驻；没装单元时浏览器扩展第一次用到也会自动拉起
# 公众号「AI之境」
set -euo pipefail
DATA="${PIBOT_DATA_DIR:-$HOME/pi-bot-cn-data}"
PORT="${PIBOT_BROWSER_CDP_PORT:-9223}"
DISP="${PIBOT_BROWSER_DISPLAY:-:99}"
W="${PIBOT_BROWSER_W:-1280}"; H="${PIBOT_BROWSER_H:-860}"
PROFILE="$DATA/browser/profile"
mkdir -p "$PROFILE" "$DATA/browser/downloads" "$DATA/logs"
CHROME="${PIBOT_CHROME:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | sort -V | tail -1)}"
[ -x "$CHROME" ] || { echo "找不到 Chromium：先在仓库目录运行 bash scripts/install-browser.sh" >&2; exit 1; }

# 虚拟屏幕：没在跑就起一个（-nolisten tcp：X11 也不开网络端口）
if ! xdpyinfo -display "$DISP" >/dev/null 2>&1; then
  Xvfb "$DISP" -screen 0 "${W}x${H}x24" -nolisten tcp -ac >"$DATA/logs/xvfb.log" 2>&1 &
  for _ in $(seq 50); do xdpyinfo -display "$DISP" >/dev/null 2>&1 && break; sleep 0.1; done
fi
export DISPLAY="$DISP"
# 上次异常退出留下的锁
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie"
exec "$CHROME" \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --window-position=0,0 --window-size="$W,$H" --start-maximized \
  --lang=zh-CN --accept-lang=zh-CN,zh,en \
  --no-first-run --no-default-browser-check --password-store=basic \
  --disable-blink-features=AutomationControlled \
  --disable-features=Translate,MediaRouter --disable-session-crashed-bubble --hide-crash-restore-bubble \
  --disable-dev-shm-usage \
  about:blank
