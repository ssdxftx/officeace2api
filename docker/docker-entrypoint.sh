#!/bin/sh
# 容器入口：修正挂载目录属主后降权到 node 用户运行。
#
# 为什么需要：compose 里用 bind mount（./data、./logs）时，宿主机目录可能由
# root 创建，而服务要以非 root 身份写 refresh_token / 日志。这里在启动时把
# 两个目录交给 node，再 exec 成 node 进程 —— PID 1 仍然是 node，SIGTERM
# 能直接送到服务本身（它自己有优雅退出的处理）。
set -eu

DATA_DIR=/app/data
LOG_DIR=/app/logs

mkdir -p "$DATA_DIR" "$LOG_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" "$LOG_DIR" 2>/dev/null || true
  exec su-exec node:node "$@"
fi

exec "$@"
