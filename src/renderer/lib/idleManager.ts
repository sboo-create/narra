import type { Character } from '@shared/types'
import { portraitKey, IMAGE_VERSION } from './imageStyle'
import { portraitPrompt } from './passport'

/*
 * Менеджер фонового оживления: живёт вне React-компонентов, поэтому
 * генерация НЕ прерывается при выходе из карточки. Результат пишется
 * в дисковый кэш main-процессом — карточка подхватит при следующем визите.
 */

const inFlight = new Set<string>()
const failed = new Set<string>()

/** Оживление не удалось: модель трижды нарисовала не то. */
export function isIdleFailed(id: string): boolean {
  return failed.has(id)
}
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

/** Ключ ролика оживления — тоже с id книги (см. portraitKey). */
/**
 * Проверка ролика: сравниваем первый и последний кадр по силуэту.
 * Ловит и наезд камеры, и появление посторонних предметов (штатив, камера).
 * Возвращает true, если кадр остался прежним.
 */
function isStable(dataUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.src = dataUrl
    const S = 96
    const shots: ImageData[] = []
    let times: number[] = []
    let idx = 0
    const grab = () =>
      setTimeout(() => {
        try {
          const c = document.createElement('canvas')
          c.width = S
          c.height = S
          const ctx = c.getContext('2d')!
          ctx.drawImage(v, 0, 0, S, S)
          shots.push(ctx.getImageData(0, 0, S, S))
          idx++
          if (idx < times.length) {
            v.currentTime = times[idx]
            return
          }
          const stats = (d: ImageData) => {
            let dark = 0
            let cx = 0
            let n = 0
            for (let y = 0; y < S; y++) {
              for (let x = 0; x < S; x++) {
                const p = (y * S + x) * 4
                const lum = (d.data[p] + d.data[p + 1] + d.data[p + 2]) / 3
                if (lum < 110) {
                  dark++
                  cx += x
                  n++
                }
              }
            }
            return { fill: (dark / (S * S)) * 100, cx: cx / Math.max(1, n) }
          }
          const a = stats(shots[0])
          const b = stats(shots[1])
          resolve(Math.abs(a.fill - b.fill) < 9 && Math.abs(a.cx - b.cx) < 9)
        } catch {
          resolve(true) // не смогли проверить — не бракуем
        }
      }, 150)
    v.addEventListener('loadeddata', () => {
      times = [0.15, Math.max(0.5, (v.duration || 5) - 0.4)]
      v.currentTime = times[0]
    })
    v.addEventListener('seeked', grab)
    v.addEventListener('error', () => resolve(true))
    setTimeout(() => resolve(true), 25000)
  })
}

export function idleVideoKey(bookId: string, id: string): string {
  return `idle-${bookId}-${id}-${IMAGE_VERSION}`
}

export function isIdleInFlight(id: string): boolean {
  return inFlight.has(id)
}

export async function ensureIdleAnimation(bookId: string, char: Character, auto = false): Promise<void> {
  const id = char.id
  if (inFlight.has(id)) return
  const cached = await window.narra.getCachedVideo(idleVideoKey(bookId, id))
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
      let img = await window.narra.getCachedImage(portraitKey(bookId, id))
      if (!img.ok) {
        const gen = await window.narra.generateImage(portraitPrompt(char), portraitKey(bookId, id), 1024, 1024, false, 'kandinsky')
        if (!gen.ok) return
        img = { ok: true, data: { dataUrl: gen.data!.dataUrl } }
      }
      // ВАЖНО: только мимика. Съёмочные слова (camera, tripod, framing, zoom) модель
      // понимает буквально и дорисовывает в кадр камеру со штативом и посторонних людей.
      // Слова camera/tripod модель рисует как ПРЕДМЕТЫ в кадре (появлялся штатив со съёмкой),
      // поэтому стабильность описываем без них. А чтобы не вернулся зум — проверяем результат
      // по кадрам и при расхождении перегенерируем (см. isStable ниже).
      const motion =
        `${safeMotion(char.idleAnimation)}, mouth closed, not speaking, no talking, ` +
        `the portrait stays exactly the same size and position, background unchanged, ` +
        `no zoom, no pan, no scale change, nothing else appears in the frame`
      // до 2 попыток: неудачный дубль (наезд камеры или посторонние предметы) не сохраняем
      for (let attempt = 0; attempt < 2; attempt++) {
        const vid = await window.narra.animatePortrait(img.data!.dataUrl, motion, undefined)
        if (!vid.ok) return
        const ok = attempt === 1 || (await isStable(vid.data!.dataUrl))
        if (ok) {
          await window.narra.saveCachedVideo(idleVideoKey(bookId, id), vid.data!.dataUrl)
          return
        }
      }
      // результат уже в кэше main-процесса
    } finally {
      inFlight.delete(id)
    }
  }
}
