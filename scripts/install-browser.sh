#!/usr/bin/env bash
# 一次性安装「自己的浏览器」所需的东西（Ubuntu 22.04/24.04）。公众号「AI之境」
# 1) 虚拟屏幕 / 录屏转 GIF / 中文字体  2) Playwright 的 Chromium（走 npmmirror 国内镜像）
# 3) AppArmor：允许 Chromium 用沙箱（Ubuntu 24.04 默认禁止非特权 userns）  4) systemd 常驻
set -euo pipefail
cd "$(dirname "$0")/.."
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q xvfb x11-utils ffmpeg fonts-noto-cjk fonts-noto-color-emoji
npm install --no-audit --no-fund
PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST:-https://npmmirror.com/mirrors/playwright}" \
  node node_modules/playwright-core/cli.js install chromium || true   # 只需要完整版 chromium；headless shell 下载失败可以忽略
CHROME=$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux/chrome | sort -V | tail -1)
"$CHROME" --version
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  sudo tee /etc/apparmor.d/pibot-chrome >/dev/null <<AA
abi <abi/4.0>,
include <tunables/global>
profile pibot-chrome $HOME/.cache/ms-playwright/chromium-*/chrome-linux/chrome flags=(unconfined) {
  userns,
  include if exists <local/pibot-chrome>
}
AA
  sudo apparmor_parser -r /etc/apparmor.d/pibot-chrome
fi
[ -f "$HOME/.config/pi-bot-cn/vault.json" ] || { mkdir -p "$HOME/.config/pi-bot-cn"; echo '{}' > "$HOME/.config/pi-bot-cn/vault.json"; }
chmod 600 "$HOME/.config/pi-bot-cn/vault.json"
sudo install -m 644 systemd/pi-bot-cn-browser.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pi-bot-cn-browser.service
sleep 3
curl -s "http://127.0.0.1:${PIBOT_BROWSER_CDP_PORT:-9223}/json/version" | grep -o '"Browser": *"[^"]*"' || { echo "浏览器没起来，看 journalctl -u pi-bot-cn-browser"; exit 1; }
echo "✅ 浏览器就绪（调试端口只在 127.0.0.1）"
