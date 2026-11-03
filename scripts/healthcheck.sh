#!/usr/bin/env bash
# 每分钟由 pi-bot-cn-health.timer 调用：/health 连续 2 次失败就重启网关。
set -u
PORT="${PIBOT_LOCAL_PORT:-8787}"
STATE=/run/pi-bot-cn-health.fail
ok() { curl -fsS -m 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; }
if ok; then rm -f "$STATE"; exit 0; fi
sleep 3
if ok; then rm -f "$STATE"; exit 0; fi
n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STATE"
logger -t pi-bot-cn-health "health check failed (${n}); restarting pi-bot-cn"
systemctl restart pi-bot-cn.service
