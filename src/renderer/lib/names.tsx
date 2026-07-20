import React from 'react'
import type { Character } from '@shared/types'

interface Match {
  start: number
  end: number
  charId: string
}

function patternFor(name: string): RegExp {
  // имена на -а/-я склоняются: берём основу + до 2 русских букв окончания
  const endsVowel = /[ая]$/i.test(name)
  const root = endsVowel ? name.slice(0, -1) : name
  const esc = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tail = endsVowel ? '[а-яё]{0,2}' : ''
  // границы слова для кириллицы через lookaround
  return new RegExp(`(?<![А-Яа-яЁё])${esc}${tail}(?![А-Яа-яЁё])`, 'gi')
}

/**
 * Разбивает текст абзаца на React-узлы, делая имена персонажей кликабельными.
 */
export function renderWithNames(
  text: string,
  characters: Character[],
  onClick: (charId: string, rect: DOMRect) => void
): React.ReactNode[] {
  const matches: Match[] = []
  for (const c of characters) {
    // кликабельны имя И фамилия (все слова полного имени длиной от 4 букв)
    const words = [...new Set([c.name, ...c.fullName.split(/\s+/)])].filter((w) => w.length >= 4)
    for (const w of words) {
      const re = patternFor(w)
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length, charId: c.id })
        if (m.index === re.lastIndex) re.lastIndex++
      }
    }
  }
  matches.sort((a, b) => a.start - b.start)

  // убираем пересечения (оставляем первый)
  const clean: Match[] = []
  let lastEnd = -1
  for (const mt of matches) {
    if (mt.start >= lastEnd) {
      clean.push(mt)
      lastEnd = mt.end
    }
  }

  const nodes: React.ReactNode[] = []
  let cursor = 0
  clean.forEach((mt, i) => {
    if (mt.start > cursor) nodes.push(text.slice(cursor, mt.start))
    nodes.push(
      <span
        key={`n-${i}-${mt.start}`}
        className="char-name"
        onClick={(e) => {
          e.stopPropagation()
          onClick(mt.charId, (e.currentTarget as HTMLElement).getBoundingClientRect())
        }}
      >
        {text.slice(mt.start, mt.end)}
      </span>
    )
    cursor = mt.end
  })
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}
