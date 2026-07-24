#!/usr/bin/env bash
# Push уже проверенного commit. Скрипт намеренно не делает git add/commit.
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH="$(git branch --show-current)"
[ "${REVIEW_APPROVED:-0}" = "1" ] || { echo "Сначала нужно независимое ревью; затем REVIEW_APPROVED=1 npm run push"; exit 1; }
case "$BRANCH" in feat/*) ;; *) echo "Push разрешён только из feat/*, сейчас: $BRANCH"; exit 1;; esac
test -z "$(git status --porcelain)" || { echo "Рабочее дерево не чистое — сначала создай проверенный commit."; exit 1; }
npm ci --prefix server
npm run typecheck
npm run test:gateway
npm run test:stats
npm run security:audit
npm audit --prefix server --audit-level=moderate
git push origin "HEAD:$BRANCH"
echo "✅ Проверенный commit отправлен в origin/$BRANCH"
