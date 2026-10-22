#!/usr/bin/env bash
# 本地一键启动：后端 3010 + 前端 5183
set -e
cd "$(dirname "$0")"

if ! mysqladmin ping -uroot -proot --silent 2>/dev/null; then
  echo "⚠️  连不上本地 MySQL（root/root），请先启动 MySQL"
  exit 1
fi

echo "▶ 启动后端 :3010"
(cd backend && npm run dev) &
BACK=$!

echo "▶ 启动前端 :5183"
(cd frontend && npm run dev) &
FRONT=$!

trap "kill $BACK $FRONT 2>/dev/null" EXIT
echo "✅ 打开 http://localhost:5183 （admin / admin123）"
wait
