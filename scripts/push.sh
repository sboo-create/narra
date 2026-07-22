#!/bin/bash
# Отправка изменений в GitHub: npm run push "что сделано"
set -e
cd "$(dirname "$0")/.."
MSG="${1:-обновление}"
git add -A
git diff --cached --quiet && { echo "Нечего отправлять — изменений нет."; exit 0; }
git -c user.name="narra" -c user.email="narra@local" commit -m "$MSG"
git push origin main
echo "✅ Отправлено в GitHub: $MSG"
