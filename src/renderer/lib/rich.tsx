import React, { useState } from 'react'
import type { Character } from '@shared/types'
import { renderWithNames } from './names'

/*
 * Богатый рендер абзаца:
 *  - сноски ficbook `{?}[содержимое]` → маркер [n], раскрывается по клику;
 *  - URL → кликабельная ссылка (откроется во внешнем браузере);
 *  - имена персонажей → кликабельны (renderWithNames).
 */

const FOOTNOTE_RE = /\{\?\}\[([^\]]*)\]/g
const URL_RE = /(https?:\/\/[^\s)»«]+)/g

function Footnote({ n, content }: { n: number; content: string }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="fn">
      <button className="fn__mark" onClick={() => setOpen(!open)}>
        [{n}]
      </button>
      {open && <span className="fn__body">{linkifyPlain(content)}</span>}
    </span>
  )
}

/** Только ссылки (для содержимого сносок и примечаний). */
export function linkifyPlain(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  const re = new RegExp(URL_RE.source, 'g')
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <a key={`u${m.index}`} href={m[1]} target="_blank" rel="noreferrer">
        {m[1].replace(/^https?:\/\//, '').slice(0, 42)}
        {m[1].replace(/^https?:\/\//, '').length > 42 ? '…' : ''}
      </a>
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function renderRich(
  text: string,
  characters: Character[],
  onNameClick: (charId: string, rect: DOMRect) => void
): React.ReactNode[] {
  // 1) вырезаем сноски
  const notes: string[] = []
  const cleaned = text.replace(FOOTNOTE_RE, (_all, content: string) => {
    notes.push(content.trim())
    return `${notes.length - 1}`
  })

  // 2) режем по ссылкам и маркерам сносок
  const out: React.ReactNode[] = []
  const re = /(https?:\/\/[^\s)»«]+|\d+)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(cleaned)) !== null) {
    if (m.index > last) {
      out.push(...renderWithNames(cleaned.slice(last, m.index), characters, onNameClick))
    }
    const tok = m[0]
    if (tok.startsWith('')) {
      const idx = Number(tok.slice(1, -1))
      out.push(<Footnote key={`f${key++}`} n={idx + 1} content={notes[idx] || ''} />)
    } else {
      out.push(
        <a key={`l${key++}`} href={tok} target="_blank" rel="noreferrer">
          {tok.replace(/^https?:\/\//, '').slice(0, 42)}
          {tok.replace(/^https?:\/\//, '').length > 42 ? '…' : ''}
        </a>
      )
    }
    last = m.index + m[0].length
  }
  if (last < cleaned.length) {
    out.push(...renderWithNames(cleaned.slice(last), characters, onNameClick))
  }
  return out
}
