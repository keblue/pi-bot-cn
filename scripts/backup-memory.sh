#!/usr/bin/env bash
# 每日备份记忆 / 会话 / outbox / chats.json，保留 14 天。不含任何密钥（密钥在 ~/.config/pi-bot-cn/env，不备份）。
set -euo pipefail
DATA="${PIBOT_DATA_DIR:-$HOME/pi-bot-cn-data}"
DEST="$DATA/backups"
mkdir -p "$DEST"
STAMP=$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)
cd "$DATA"
tar czf "$DEST/pibot-$STAMP.tgz" --ignore-failed-read memory sessions outbox chats.json 2>/dev/null || true
chmod 600 "$DEST/pibot-$STAMP.tgz"
find "$DEST" -name 'pibot-*.tgz' -mtime +14 -delete
echo "backup ok: $DEST/pibot-$STAMP.tgz ($(du -h "$DEST/pibot-$STAMP.tgz" | cut -f1))"
