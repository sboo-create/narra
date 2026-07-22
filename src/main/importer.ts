import { app, dialog } from 'electron'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import type { ApiResult, Chapter, Character, Fanfic } from '../shared/types'

const execFileP = promisify(execFile)

export function userBooksDir(): string {
  return path.join(app.getPath('userData'), 'books')
}

// ---------- декодирование ----------
// Выбираем кодировку по качеству результата: считаем кириллицу и знаки замены.
function normalizeEol(t: string): string {
  return t.replace(/\r\n?/g, '\n')
}

function decode(buf: Buffer): string {
  const head = buf.subarray(0, 300).toString('utf8')
  if (/windows-1251/i.test(head)) return new TextDecoder('windows-1251').decode(buf)
  if (/koi8-r/i.test(head)) return new TextDecoder('koi8-r').decode(buf)
  // валидный UTF-8 — это UTF-8: случайный текст в 1251 почти никогда не проходит
  // строгую проверку, а вот кракозябры «РµСЂ…» формально тоже кириллица —
  // поэтому НЕ сравниваем счётчиком, а проверяем валидность
  try {
    return normalizeEol(new TextDecoder('utf-8', { fatal: true }).decode(buf))
  } catch {
    /* не utf-8 — выбираем из однобайтовых */
  }
  const sample = buf.subarray(0, 60000)
  const score = (t: string) => t.match(/[а-яёА-ЯЁ]/g)?.length || 0
  let best = 'windows-1251'
  let bestScore = -1
  for (const enc of ['windows-1251', 'koi8-r'] as const) {
    const sc = score(new TextDecoder(enc).decode(sample))
    if (sc > bestScore) {
      bestScore = sc
      best = enc
    }
  }
  return normalizeEol(new TextDecoder(best).decode(buf))
}

// ---------- FB2 ----------
function stripTags(t: string): string {
  return t
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, c: string) => String.fromCharCode(Number(c)))
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function parseFb2(text: string): { title: string; author: string; chapters: Chapter[] } {
  const titleM = text.match(/<book-title>(.*?)<\/book-title>/s)
  const fnM = text.match(/<first-name>(.*?)<\/first-name>/s)
  const lnM = text.match(/<last-name>(.*?)<\/last-name>/s)
  const title = titleM ? stripTags(titleM[1]) : 'Без названия'
  const author = [fnM, lnM].map((m) => (m ? stripTags(m[1]) : '')).filter(Boolean).join(' ') || 'Неизвестный автор'

  const bodyStart = text.indexOf('<body')
  const body = bodyStart >= 0 ? text.slice(bodyStart).split('</body>')[0] : text

  // стек-парсер: лист-секции (без вложенных)
  const toks = body.split(/(<section[^>]*>|<\/section>)/)
  const stack: { buf: string[]; hasChild: boolean }[] = []
  const leaves: string[] = []
  for (const tok of toks) {
    if (tok.startsWith('<section')) {
      stack.push({ buf: [], hasChild: false })
    } else if (tok === '</section>') {
      const node = stack.pop()
      if (node && !node.hasChild) leaves.push(node.buf.join(''))
      if (stack.length) stack[stack.length - 1].hasChild = true
    } else if (stack.length) {
      stack[stack.length - 1].buf.push(tok)
    }
  }

  const chapters: Chapter[] = []
  for (const c of leaves) {
    const tm = c.match(/<title>(.*?)<\/title>/s)
    const secTitle = tm ? stripTags(tm[1]) : ''
    const bodytext = tm ? c.slice(c.indexOf(tm[0]) + tm[0].length) : c
    const paras = [...bodytext.matchAll(/<p>(.*?)<\/p>/gs)].map((m) => stripTags(m[1])).filter(Boolean)
    if (paras.length < 3) continue
    chapters.push({
      number: chapters.length + 1,
      title: secTitle || `Глава ${chapters.length + 1}`,
      summary: '',
      characters: [],
      text: paras.join('\n\n')
    })
  }
  return { title, author, chapters }
}

// ---------- TXT ----------
function parseTxt(text: string, fallbackTitle: string): { title: string; author: string; chapters: Chapter[] } {
  const norm = text.replace(/\r\n/g, '\n')
  const parts = norm.split(/\n(?=\s*(?:Глава|ГЛАВА|Chapter)\s+[\wIVXLC0-9])/)
  const chapters: Chapter[] = []
  if (parts.length > 2) {
    for (const p of parts) {
      const lines = p.trim().split('\n')
      const title = lines[0].trim().slice(0, 80)
      const body = lines.slice(1).join('\n').trim()
      if (body.split(/\s+/).length < 100) continue
      chapters.push({
        number: chapters.length + 1,
        title,
        summary: '',
        characters: [],
        text: body.replace(/\n{3,}/g, '\n\n')
      })
    }
  }
  if (chapters.length === 0) {
    // без явных глав — режем по ~2500 слов
    const words = norm.split(/\s+/)
    for (let i = 0; i < words.length; i += 2500) {
      chapters.push({
        number: chapters.length + 1,
        title: `Часть ${chapters.length + 1}`,
        summary: '',
        characters: [],
        text: words.slice(i, i + 2500).join(' ')
      })
    }
  }
  return { title: fallbackTitle, author: 'Неизвестный автор', chapters }
}

// ---------- EPUB ----------
async function parseEpub(filePath: string): Promise<{ title: string; author: string; chapters: Chapter[] }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'narra-epub-'))
  await execFileP('/usr/bin/unzip', ['-o', filePath, '-d', tmp])
  // container.xml → путь к OPF
  const container = await fs.readFile(path.join(tmp, 'META-INF/container.xml'), 'utf8')
  const opfRel = container.match(/full-path="([^"]+)"/)?.[1]
  if (!opfRel) throw new Error('EPUB: не найден OPF')
  const opfPath = path.join(tmp, opfRel)
  const opfDir = path.dirname(opfPath)
  const opf = await fs.readFile(opfPath, 'utf8')
  const title = stripTags(opf.match(/<dc:title[^>]*>(.*?)<\/dc:title>/s)?.[1] || 'Без названия')
  const author = stripTags(opf.match(/<dc:creator[^>]*>(.*?)<\/dc:creator>/s)?.[1] || 'Неизвестный автор')
  // manifest id→href, spine — порядок чтения
  const items = new Map<string, string>()
  for (const m of opf.matchAll(/<item\s+[^>]*>/g)) {
    const tag = m[0]
    const id = tag.match(/\bid="([^"]+)"/)?.[1]
    const href = tag.match(/\bhref="([^"]+)"/)?.[1]
    if (id && href) items.set(id, href)
  }
  const spine = [...opf.matchAll(/<itemref\s+[^>]*idref="([^"]+)"/g)].map((m) => m[1])
  const chapters: Chapter[] = []
  for (const idref of spine) {
    const href = items.get(idref)
    if (!href || !/\.x?html?$/i.test(href)) continue
    let html = ''
    try {
      html = decode(await fs.readFile(path.join(opfDir, decodeURIComponent(href))))
    } catch {
      continue
    }
    const headM = html.match(/<(h1|h2|h3)[^>]*>(.*?)<\/\1>/s)
    const secTitle = headM ? stripTags(headM[2]).slice(0, 80) : ''
    const body = html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<(p|div|br|h[1-6]|li)[^>]*>/gi, '\n')
    const text = stripTags(body).replace(/\n{3,}/g, '\n\n').trim()
    if (text.split(/\s+/).length < 100) continue
    chapters.push({
      number: chapters.length + 1,
      title: secTitle || `Глава ${chapters.length + 1}`,
      summary: '',
      characters: [],
      text
    })
  }
  return { title, author, chapters }
}

// ---------- PDF ----------
async function parsePdf(filePath: string): Promise<{ title: string; author: string; chapters: Chapter[] }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfParse = require('pdf-parse') as (b: Buffer) => Promise<{ text: string; info?: { Title?: string; Author?: string } }>
  const data = await pdfParse(await fs.readFile(filePath))
  const base = path.basename(filePath).replace(/\.pdf$/i, '')
  const parsed = parseTxt(data.text || '', data.info?.Title || base)
  if (data.info?.Author) parsed.author = String(data.info.Author)
  return parsed
}

/** Часто упоминаемые имена — подсказка LLM, чтобы главный герой не потерялся. */
function topNames(chapters: Chapter[]): string {
  const STOP = new Set([
    'Глава','Часть','Автор','Примечание','Комментарий','Но','И','А','Он','Она','Они','Мы','Ты','Вы','Я','Это','Как',
    'Когда','Что','Если','Так','Все','Всё','Да','Нет','Потом','После','Перед','Может','Только','Ещё','Еще','Просто','Затем'
  ])
  const freq = new Map<string, number>()
  for (const ch of chapters) {
    // слово с заглавной, НЕ в начале предложения — почти всегда имя собственное
    for (const m of ch.text.matchAll(/(?:[^.!?…\n]\s+)([А-ЯЁ][а-яё]{3,})/g)) {
      const w = m[1]
      if (STOP.has(w)) continue
      freq.set(w, (freq.get(w) || 0) + 1)
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([w, n]) => `${w} (${n})`)
    .join(', ')
}

/**
 * Выборка для разметки героев. Частотность имён — по всей книге (чтобы главный герой
 * не потерялся), а сами ТЕКСТЫ — только из первых глав: иначе профили героев
 * пересказывают финал и спойлерят читателю.
 */
function buildExcerpt(chapters: Chapter[], description?: string): string {
  const pick = (ch: Chapter, n: number) => `[${ch.title}]\n${ch.text.slice(0, n)}`
  const parts = [
    description ? `Авторская аннотация: ${description}` : '',
    `Часто упоминаемые имена во всей книге (имя и число упоминаний): ${topNames(chapters)}`,
    pick(chapters[0], 6000),
    chapters[1] ? pick(chapters[1], 4000) : '',
    chapters[2] ? pick(chapters[2], 3000) : ''
  ].filter(Boolean)
  return parts.join('\n\n')
}

// ---------- импорт по ссылке (AO3 / Фикбук) ----------
import { getSettings } from './store'

function proxyFetchUrl(target: string): string {
  const base = getSettings().proxyUrl.replace(/\/+$/, '')
  return `${base}/import/fetch?url=${encodeURIComponent(target)}`
}

async function fetchViaProxy(target: string): Promise<Buffer> {
  const r = await fetch(proxyFetchUrl(target))
  if (!r.ok) {
    let msg = `загрузка не удалась (${r.status})`
    try {
      msg = ((await r.json()) as { error?: string }).error || msg
    } catch {
      /* не json */
    }
    throw new Error(msg)
  }
  return Buffer.from(await r.arrayBuffer())
}

async function importFromAo3(workId: string): Promise<{ title: string; author: string; chapters: Chapter[] }> {
  // AO3 официально отдаёт epub — качаем его и разбираем готовым парсером
  const buf = await fetchViaProxy(`https://archiveofourown.org/downloads/${workId}/work.epub`)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'narra-ao3-'))
  const file = path.join(tmp, 'work.epub')
  await fs.writeFile(file, buf)
  return parseEpub(file)
}

async function importFromFicbook(
  rawUrl: string
): Promise<{ title: string; author: string; chapters: Chapter[]; description?: string; pairing?: string; tags?: string[] }> {
  const idM = rawUrl.match(/readfic\/([0-9a-zA-Z-]+)/)
  const url = idM ? `https://ficbook.net/readfic/${idM[1]}` : rawUrl
  const html = decode(await fetchViaProxy(url))
  const title = stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] || 'Без названия')
  const author =
    stripTags(html.match(/class="creator-username"[^>]*>([\s\S]*?)<\/a>/)?.[1] || '') ||
    stripTags(html.match(/itemprop="author"[^>]*>([\s\S]*?)<\/(a|span)>/)?.[1] || '') ||
    'Автор с Фикбука'
  // id работы: старый числовой ИЛИ новый uuid-слаг; query и якорь отбрасываем
  const fidM = url.match(/readfic\/([0-9a-zA-Z-]+)/)
  if (!fidM) throw new Error('Не понял ссылку Фикбука')
  const fid = fidM[1]
  const esc = fid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // главы — только ЧИСЛОВЫЕ под-id: служебные /comments и /download отсекаются сами
  const partIds: string[] = []
  for (const m of html.matchAll(new RegExp(`href="/readfic/${esc}/(\\d+)`, 'g'))) {
    if (!partIds.includes(m[1])) partIds.push(m[1])
  }
  const grabContent = (page: string) => {
    const m =
      page.match(/<div[^>]*id="content"[^>]*>([\s\S]*?)<\/div>\s*<div/) ||
      page.match(/<div[^>]*id="content"[^>]*>([\s\S]*?)$/)
    if (!m) return ''
    // на Фикбуке абзацы разделены <br>, а не <p> — каждый перенос делаем абзацным,
    // иначе весь текст (и диалоги) слипается в один блок
    const body = m[1]
      .replace(/<br\s*\/?>/gi, '\n\n')
      .replace(/<\/(p|div)>/gi, '\n\n')
      .replace(/<(p|div)[^>]*>/gi, '\n')
    return stripTags(body)
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }
  const chapters: Chapter[] = []
  if (partIds.length === 0) {
    const text = grabContent(html)
    if (!text) {
      const adult = /только для зарегистрированных|войдите|18\+/i.test(html)
      throw new Error(
        adult
          ? 'Похоже, работа 18+ — Фикбук отдаёт её только после входа. Скачай fb2 со страницы работы и добавь через «+ Своя книга»'
          : 'Не нашёл текст — возможно, работа скрыта или сайт поменял разметку'
      )
    }
    chapters.push({ number: 1, title: title.slice(0, 80), summary: '', characters: [], text })
  } else {
    for (const pid of partIds) {
      const page = decode(await fetchViaProxy(`https://ficbook.net/readfic/${fid}/${pid}`))
      const chTitle = stripTags(page.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] || `Глава ${chapters.length + 1}`)
      const text = grabContent(page)
      if (text.split(/\s+/).length >= 30) {
        chapters.push({ number: chapters.length + 1, title: chTitle.slice(0, 80), summary: '', characters: [], text })
      }
      await new Promise((r) => setTimeout(r, 800)) // вежливая пауза между главами
    }
  }
  // описание работы и шапка — берём авторские, а не выдуманные
  const descM = html.match(/js-public-beta-description[^>]*>([\s\S]*?)<\/div>/)
  const description = descM ? stripTags(descM[1]).replace(/\n{2,}/g, ' ').trim() : ''
  const fandomM = html.match(/href="\/fanfiction\/[^"]*"[^>]*>([^<]{3,60})<\/a>/)
  const pairM = html.match(/Пэйринг и персонажи:[\s\S]{0,600}?<div[^>]*>([\s\S]*?)<\/div>/)
  const pairing = pairM ? stripTags(pairM[1]).slice(0, 120) : fandomM ? stripTags(fandomM[1]) : 'Фанфик'
  const tags = [...html.matchAll(/class="tag[^"]*"[^>]*>([^<]{2,40})</g)]
    .map((m) => stripTags(m[1]))
    .filter(Boolean)
    .slice(0, 6)
  return { title, author, chapters, description, pairing, tags }
}

export async function importBookFromUrl(url: string): Promise<ApiResult<ImportedBookMeta>> {
  try {
    const clean = url.trim()
    const ao3 = clean.match(/archiveofourown\.org\/works\/(\d+)/)
    const fb = clean.match(/ficbook\.net\/readfic\/\d+/)
    if (!ao3 && !fb) {
      return { ok: false, error: 'Поддерживаются ссылки AO3 (archiveofourown.org/works/…) и Фикбука (ficbook.net/readfic/…)', code: 'PARSE' }
    }
    const parsed = (ao3 ? await importFromAo3(ao3[1]) : await importFromFicbook(clean)) as {
      title: string
      author: string
      chapters: Chapter[]
      description?: string
      pairing?: string
      tags?: string[]
    }
    if (parsed.chapters.length === 0) return { ok: false, error: 'Не удалось найти главы по ссылке', code: 'PARSE' }
    const id = `u-${Date.now().toString(36)}`
    const words = parsed.chapters.reduce((n, c) => n + c.text.split(/\s+/).length, 0)
    const book: Fanfic = {
      id,
      title: parsed.title,
      author: parsed.author,
      source: clean,
      pairing: parsed.pairing || 'Загруженная книга',
      tags: ['Мои книги', ...(parsed.tags || [])],
      description: parsed.description || `${parsed.title} — ${parsed.author}. ${parsed.chapters.length} глав.`,
      coverPrompt: `обложка книги «${parsed.title}» (${parsed.author}), атмосферная, по духу произведения`,
      chapters: parsed.chapters
    }
    await fs.mkdir(userBooksDir(), { recursive: true })
    await fs.writeFile(path.join(userBooksDir(), `${id}.json`), JSON.stringify(book), 'utf8')
    const excerpt = buildExcerpt(parsed.chapters, book.description)
    return { ok: true, data: { id, title: parsed.title, author: parsed.author, chapters: parsed.chapters.length, words, excerpt } }
  } catch (e) {
    return { ok: false, error: `Импорт по ссылке не удался: ${(e as Error).message}`, code: 'UNKNOWN' }
  }
}

// ---------- импорт ----------
export interface ImportedBookMeta {
  id: string
  title: string
  author: string
  chapters: number
  words: number
  excerpt: string // первые главы для авторазметки персонажей
}

export async function importBook(): Promise<ApiResult<ImportedBookMeta>> {
  const pick = await dialog.showOpenDialog({
    title: 'Выбери книгу',
    filters: [{ name: 'Книги', extensions: ['fb2', 'txt', 'epub', 'pdf', 'zip'] }],
    properties: ['openFile']
  })
  if (pick.canceled || !pick.filePaths[0]) return { ok: false, error: 'Отменено', code: 'UNKNOWN' }
  let filePath = pick.filePaths[0]

  try {
    if (filePath.toLowerCase().endsWith('.zip')) {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'narra-import-'))
      await execFileP('/usr/bin/unzip', ['-o', filePath, '-d', tmp])
      const files = await fs.readdir(tmp)
      const inner =
        files.find((f) => f.toLowerCase().endsWith('.fb2')) ||
        files.find((f) => f.toLowerCase().endsWith('.epub')) ||
        files.find((f) => f.toLowerCase().endsWith('.txt')) ||
        files.find((f) => f.toLowerCase().endsWith('.pdf'))
      if (!inner) return { ok: false, error: 'В архиве нет .fb2/.epub/.txt/.pdf', code: 'UNKNOWN' }
      filePath = path.join(tmp, inner)
    }

    const low = filePath.toLowerCase()
    let parsed: { title: string; author: string; chapters: Chapter[] }
    if (low.endsWith('.epub')) parsed = await parseEpub(filePath)
    else if (low.endsWith('.pdf')) parsed = await parsePdf(filePath)
    else {
      const text = decode(await fs.readFile(filePath))
      const base = path.basename(filePath).replace(/\.(fb2|txt)$/i, '')
      parsed = low.endsWith('.fb2') ? parseFb2(text) : parseTxt(text, base)
    }

    if (parsed.chapters.length === 0) return { ok: false, error: 'Не удалось найти главы в файле', code: 'PARSE' }

    const id = `u-${Date.now().toString(36)}`
    const words = parsed.chapters.reduce((n, c) => n + c.text.split(/\s+/).length, 0)
    const book: Fanfic = {
      id,
      title: parsed.title,
      author: parsed.author,
      pairing: 'Загруженная книга',
      tags: ['Мои книги'],
      description: `${parsed.title} — ${parsed.author}. ${parsed.chapters.length} глав.`,
      coverPrompt: `обложка книги «${parsed.title}» (${parsed.author}), атмосферная, по духу произведения`,
      chapters: parsed.chapters
    }
    await fs.mkdir(userBooksDir(), { recursive: true })
    await fs.writeFile(path.join(userBooksDir(), `${id}.json`), JSON.stringify(book), 'utf8')

    const excerpt = buildExcerpt(parsed.chapters)
    return { ok: true, data: { id, title: parsed.title, author: parsed.author, chapters: parsed.chapters.length, words, excerpt } }
  } catch (e) {
    return { ok: false, error: `Импорт не удался: ${(e as Error).message}`, code: 'UNKNOWN' }
  }
}

/** Выборка текста уже импортированной книги — для повторной разметки героев. */
export async function bookExcerpt(bookId: string): Promise<ApiResult<{ title: string; author: string; excerpt: string }>> {
  try {
    const raw = await fs.readFile(path.join(userBooksDir(), `${bookId}.json`), 'utf8')
    const book = JSON.parse(raw) as Fanfic
    return { ok: true, data: { title: book.title, author: book.author, excerpt: buildExcerpt(book.chapters, book.description) } }
  } catch (e) {
    return { ok: false, error: (e as Error).message, code: 'UNKNOWN' }
  }
}

/** Удалить книгу пользователя с диска. Встроенные книги удалить нельзя — их прячет renderer. */
export async function deleteBook(bookId: string): Promise<ApiResult<{ builtin: boolean }>> {
  try {
    const base = userBooksDir()
    const main = path.join(base, `${bookId}.json`)
    let existed = false
    try {
      await fs.unlink(main)
      existed = true
    } catch {
      /* не пользовательская книга */
    }
    try {
      await fs.unlink(path.join(base, `${bookId}-characters.json`))
    } catch {
      /* героев могло не быть */
    }
    return { ok: true, data: { builtin: !existed } }
  } catch (e) {
    return { ok: false, error: (e as Error).message, code: 'UNKNOWN' }
  }
}

/** Сохранить персонажей импортированной книги; unlockChapter считается по тексту. */
export async function saveBookCharacters(bookId: string, characters: Character[]): Promise<ApiResult<{ ok: true }>> {
  try {
    const bookRaw = await fs.readFile(path.join(userBooksDir(), `${bookId}.json`), 'utf8')
    const book = JSON.parse(bookRaw) as Fanfic
    // основы имён без окончаний; фамилия, общая для нескольких героев, не считается
    const stemsOf = (c: Character) =>
      [...new Set([c.name, ...c.fullName.split(/\s+/)])]
        .map((w) => w.toLowerCase().replace(/[аяйь]$/, ''))
        .filter((w) => w.length >= 4)
    const owners = new Map<string, number>()
    for (const c of characters) for (const st of new Set(stemsOf(c))) owners.set(st, (owners.get(st) || 0) + 1)
    for (const c of characters) {
      let unlock = 1
      const stems = stemsOf(c).filter((st) => owners.get(st) === 1)
      for (const ch of book.chapters) {
        const low = ch.text.toLowerCase()
        if (stems.some((st) => low.includes(st))) {
          unlock = ch.number
          break
        }
      }
      c.unlockChapter = unlock
    }
    await fs.writeFile(
      path.join(userBooksDir(), `${bookId}-characters.json`),
      JSON.stringify({ narratorVoice: 'Pon', characters }),
      'utf8'
    )
    return { ok: true, data: { ok: true } }
  } catch (e) {
    return { ok: false, error: (e as Error).message, code: 'UNKNOWN' }
  }
}
