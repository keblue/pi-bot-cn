#!/usr/bin/env bash
# sudo bash scripts/install-systemd.sh — 安装/更新 systemd 单元并启动
set -euo pipefail
cd "$(dirname "$0")/.."
install -m 644 systemd/pi-bot-cn.service systemd/pi-bot-cn-health.service systemd/pi-bot-cn-health.timer \
  systemd/pi-bot-cn-backup.service systemd/pi-bot-cn-backup.timer \
  systemd/pi-bot-cn-env.path systemd/pi-bot-cn-env-reload.service /etc/systemd/system/
chmod +x scripts/*.sh
systemctl daemon-reload
systemctl enable --now pi-bot-cn.service pi-bot-cn-health.timer pi-bot-cn-backup.timer pi-bot-cn-env.path
systemctl --no-pager status pi-bot-cn.service | head -5
