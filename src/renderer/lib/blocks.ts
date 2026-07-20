// Разбор текста главы на типизированные блоки: основной текст / примечание автора.
// Сноски ficbook `{?}[...]` и URL обрабатываются на уровне рендера абзаца (rich.tsx).

export type Block =
  | { type: 'p'; text: string }
  | { type: 'note'; title: string; text: string }

const NOTE_LINE = /^\s*(Комментарий к |Примечани|От автора|От переводчика|Прим\. ?пер)/i

export function parseBlocks(chapterText: string): Block[] {
  const blocks: Block[] = []
  const paras = chapterText.split(/\n\n+/)
  for (const para of paras) {
    const lines = para.split('\n')
    const k = lines.findIndex((l) => NOTE_LINE.test(l))
    if (k === -1) {
      const t = para.trim()
      if (t) blocks.push({ type: 'p', text: t })
      continue
    }
    const before = lines.slice(0, k).join('\n').trim()
    if (before) blocks.push({ type: 'p', text: before })
    const rest = lines.slice(k)
    const isHeader = /^\s*Комментарий к /i.test(rest[0])
    const body = isHeader ? rest.slice(1) : rest
    // примечание кончается перед диалогом или длинной прозой без ссылок
    let cut = body.length
    for (let i = 1; i < body.length; i++) {
      const line = body[i].trim()
      const looksProse =
        line.startsWith('—') || (line.length > 180 && !/https?:\/\//.test(line))
      if (looksProse) {
        cut = i
        break
      }
    }
    const noteText = body.slice(0, cut).join('\n').trim()
    const title = isHeader ? 'Примечание автора' : rest[0].trim()
    blocks.push({ type: 'note', title, text: noteText || rest.join('\n').trim() })
    const tail = body.slice(cut).join('\n').trim()
    if (tail) blocks.push({ type: 'p', text: tail })
  }
  return blocks
}

/** Только сюжетный текст (для озвучки, саммари и т.п.) — без примечаний.
 *  Ficbook-сноски {?}[...] и голые URL вычищаются: диктор не должен читать разметку. */
export function proseOnly(chapterText: string): string {
  return parseBlocks(chapterText)
    .filter((b) => b.type === 'p')
    .map((b) => (b as { text: string }).text)
    .join('\n\n')
    .replace(/\{\?\}\[[^\]]*\]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
}
