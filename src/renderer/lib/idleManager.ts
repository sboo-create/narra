import type { Character } from '@shared/types'
import { portraitKey } from './imageStyle'
import { portraitPrompt } from './passport'

/*
 * «Оживление» героя. Раньше это было генеративное видео (image-to-video), но модель
 * непредсказуемо дорисовывала в кадр камеру со штативом, наезжала на лицо или
 * подменяла сцену. Теперь оживление собирается из НЕСКОЛЬКИХ КАДРОВ ПОРТРЕТА,
 * нарисованных тем же движком и тем же паспортом: приложение мягко перетекает
 * между ними — герой «дышит» и меняет выражение, но кадр гарантированно тот же.
 */

const inFlight = new Set<string>()
let chain: Promise<void> = Promise.resolve()

/** Кадры оживления: базовый портрет + два дополнительных выражения. */
export function framePhases(c: Character): { key: string; expression: string }[] {
  const base = c.expression || 'спокойное, сдержанное'
  return [
    { key: 'b', expression: `${base}; взгляд чуть в сторону, веки слегка опущены` },
    { key: 'c', expression: `${base}; едва заметное движение брови, взгляд прямо в глаза зрителю` }
  ]
}

export function frameKey(bookId: string, id: string, phase: string): string {
  return `${portraitKey(bookId, id)}-${phase}`
}

export function isIdleInFlight(id: string): boolean {
  return inFlight.has(id)
}

/** Готовит кадры оживления. Живёт вне React — выход из карточки не прерывает работу. */
export async function ensureIdleAnimation(bookId: string, char: Character, auto = false): Promise<void> {
  const id = char.id
  if (inFlight.has(id)) return
  const phases = framePhases(char)
  const have = await Promise.all(phases.map((p) => window.narra.getCachedImage(frameKey(bookId, id, p.key))))
  if (have.every((r) => r.ok)) return
  if (auto && inFlight.size > 0) return
  inFlight.add(id)
  const run = chain.then(() => job())
  chain = run.catch(() => {})
  return run

  async function job() {
    try {
      // базовый портрет — если его ещё нет
      const base = await window.narra.getCachedImage(portraitKey(bookId, id))
      if (!base.ok) {
        const gen = await window.narra.generateImage(
          portraitPrompt(char),
          portraitKey(bookId, id),
          1024,
          1024,
          false,
          'kandinsky'
        )
        if (!gen.ok) return
      }
      for (const p of phases) {
        const key = frameKey(bookId, id, p.key)
        const cached = await window.narra.getCachedImage(key)
        if (cached.ok) continue
        await window.narra.generateImage(
          portraitPrompt({ ...char, expression: p.expression }),
          key,
          1024,
          1024,
          false,
          'kandinsky'
        )
      }
    } finally {
      inFlight.delete(id)
    }
  }
}
