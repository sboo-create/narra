import { app } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import {
  normalizeCharacterVoices,
  normalizeNarratorVoice,
  type Fanfic,
  type CharactersFile,
  type BookContent
} from '../shared/types'
import { userBooksDir } from './importer'

function contentDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'content')
  }
  return path.join(app.getAppPath(), 'content')
}

async function readJson<T>(file: string): Promise<T> {
  const raw = await fs.readFile(path.join(contentDir(), file), 'utf8')
  return JSON.parse(raw) as T
}

/**
 * Книга = пара файлов `X.json` + `X-characters.json` в content/.
 * Отдельный случай: fanfic.json + characters.json (исторически).
 */
async function scanDir(dir: string, allowPendingCharacters = false): Promise<BookContent[]> {
  let files: string[] = []
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const pairs: Array<[string, string | null]> = []
  if (files.includes('fanfic.json') && files.includes('characters.json')) {
    pairs.push(['fanfic.json', 'characters.json'])
  }
  for (const f of files) {
    if (f.endsWith('-characters.json')) {
      const base = f.replace('-characters.json', '.json')
      if (files.includes(base)) pairs.push([base, f])
    }
  }
  if (allowPendingCharacters) {
    const pairedBooks = new Set(pairs.map(([book]) => book))
    for (const file of files) {
      if (
        file.endsWith('.json') &&
        !file.endsWith('-characters.json') &&
        /^u-[a-zA-Z0-9_-]+\.json$/.test(file) &&
        !pairedBooks.has(file)
      ) {
        pairs.push([file, null])
      }
    }
  }
  const out: BookContent[] = []
  for (const [fFile, cFile] of pairs) {
    try {
      const fanficRaw = await fs.readFile(path.join(dir, fFile), 'utf8')
      const fanfic = JSON.parse(fanficRaw) as Fanfic
      const cf = cFile
        ? JSON.parse(await fs.readFile(path.join(dir, cFile), 'utf8')) as CharactersFile
        : { narratorVoice: undefined, characters: [] }
      out.push({
        fanfic,
        narratorVoice: normalizeNarratorVoice(cf.narratorVoice),
        characters: normalizeCharacterVoices(cf.characters)
      })
    } catch {
      /* битая пара — пропускаем */
    }
  }
  return out
}

export async function loadBooks(): Promise<BookContent[]> {
  const bundled = await scanDir(contentDir())
  const user = await scanDir(userBooksDir(), true)
  return [...bundled, ...user]
}
