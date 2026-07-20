// Докачивает контент, которого нет в публичном репозитории (тексты с авторскими правами).
// Использование: node scripts/fetch-content.mjs
import { writeFile } from 'node:fs/promises'
const BASE = process.env.NARRA_PROXY_URL || 'https://narra-proxy-production.up.railway.app'
const FILES = ['fanfic.json', 'characters.json', 'gwtw.json', 'gwtw-characters.json']
for (const f of FILES) {
  const r = await fetch(`${BASE}/team/content/${f}`)
  if (!r.ok) {
    console.error(`✗ ${f}: ${r.status}`)
    continue
  }
  await writeFile(new URL(`../content/${f}`, import.meta.url), Buffer.from(await r.arrayBuffer()))
  console.log(`✓ content/${f}`)
}
console.log('Готово — запускай npm run dev')
