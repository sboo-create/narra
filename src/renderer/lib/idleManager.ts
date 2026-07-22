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

/**
 * Чистит описание движения: убирает всё, из-за чего портрет «засыпает» или «говорит».
 * («slow breathing» модель понимает как сон с закрытыми глазами, «lips»/«speaks» — как речь.)
 */
function safeMotion(raw?: string): string {
  const bad = /(speak|talk|whisper|say|mutter|mouth|lips?|breath|sleep|asleep|closed? eyes|eyes closed|yawn)/i
  const cleaned = (raw || '')
    .split(/,\s*/)
    .filter((part) => part.trim() && !bad.test(part))
    .join(', ')
    .trim()
  return cleaned.length >= 12 ? cleaned : 'slight head tilt, attentive alive gaze, subtle eyebrow movement'
}

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
        const gen = await window.narra.generateImage(portraitPrompt(char), portraitKey(id), 1024, 1024, false, 'kandinsky')
        if (!gen.ok) return
        img = { ok: true, data: { dataUrl: gen.data!.dataUrl } }
      }
      // ВАЖНО: только мимика. Съёмочные слова (camera, tripod, framing, zoom) модель
      // понимает буквально и дорисовывает в кадр камеру со штативом и посторонних людей.
      // Проверенная формулировка: именно с ней получились хорошие ролики в первых книгах.
      // Единственное дополнение — санитайзер описания движения (иначе «slow breathing»
      // от LLM превращает портрет в спящего с закрытыми глазами).
      const motion = `${safeMotion(char.idleAnimation)}, mouth closed, not speaking, no talking, locked camera on tripod, absolutely fixed framing and scale, no zoom, no pan`
      await window.narra.animatePortrait(img.data!.dataUrl, motion, idleVideoKey(id))
      // результат уже в кэше main-процесса
    } finally {
      inFlight.delete(id)
    }
  }
}
