#!/bin/bash
# Установка Narra: curl -fsSL https://narra-proxy-production.up.railway.app/updates/install.sh | bash
set -e
echo "⬇  Скачиваю Narra (~100 МБ)…"
curl -fL --progress-bar https://narra-proxy-production.up.railway.app/updates/Narra-arm64.dmg -o /tmp/narra.dmg
echo "📦 Устанавливаю…"
MNT=$(hdiutil attach -nobrowse -readonly /tmp/narra.dmg | awk -F'\t' '/\/Volumes\//{print $NF; exit}')
rm -rf /Applications/Narra.app
cp -R "$MNT/Narra.app" /Applications/
hdiutil detach "$MNT" -quiet
xattr -cr /Applications/Narra.app   # снимаем карантин: сборка без подписи Apple
rm -f /tmp/narra.dmg
echo "✅ Готово — Narra в «Программах». Открываю…"
open /Applications/Narra.app
