import type { Character } from '@shared/types'
import { portraitKey, IMAGE_VERSION } from './imageStyle'
import { portraitPrompt } from './passport'

/*
 * Менеджер фонового оживления: живёт вне React-компонентов, поэтому
 * генерация НЕ прерывается при выходе из карточки. Результат пишется
 * в дисковый кэш main-процессом — карточка подхватит при следующем визите.
 */

const inFlight = new Set<string>()
let chain: Promise<void> = Promise.resolve()

export function idleVideoKey(id: string): string {
  return `idle-${id}-${IMAGE_VERSION}`
}

export function isIdleInFlight(id: string): boolean {
  return inFlight.has(id)
}

export async function ensureIdleAnimation(char: Character, auto = false): Promise<void> {
  const id = char.id
  if (inFlight.has(id)) return
  const cached = await window.narra.getCachedVideo(idleVideoKey(id))
  if (cached.ok) return
  // авто-прегенерация не создаёт толпу: если кто-то уже генерится — пропускаем,
  // сгенерится при следующем открытии карточки
  if (auto && inFlight.size > 0) return
  inFlight.add(id)
  const run = chain.then(() => job())
  chain = run.catch(() => {})
  return run

  async function job() {
    try {
      // ждём портрет (или рисуем его сами)
      let img = await window.narra.getCachedImage(portraitKey(id))
      if (!img.ok) {
        const gen = await window.narra.generateImage(portraitPrompt(char), portraitKey(id), 1024, 1024)
        if (!gen.ok) return
        img = { ok: true, data: { dataUrl: gen.data!.dataUrl } }
      }
      const motion = `${char.idleAnimation || 'stays still'}, mouth closed, not speaking, no talking, locked camera on tripod, absolutely fixed framing and scale, no zoom, no pan`
      await window.narra.animatePortrait(img.data!.dataUrl, motion, idleVideoKey(id))
      // результат уже в кэше main-процесса
    } finally {
      inFlight.delete(id)
    }
  }
}
