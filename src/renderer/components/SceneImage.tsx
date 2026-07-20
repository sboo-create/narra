import { useEffect, useRef, useState } from 'react'
import { useStore, canImage, canChat } from '../store/useStore'
import { sceneAnalysisRequest } from '../lib/prompts'
import { scenePrompt, presentIn, type ScenePerson } from '../lib/passport'
import type { Character } from '@shared/types'

interface Props {
  cacheKey: string
  chapterText: string // локальный фрагмент вокруг точки сцены
  chapterTitle: string
  chapterSummary: string
  characters?: Character[]
  autoGenerate?: boolean
}

type Status = 'checking' | 'empty' | 'thinking' | 'drawing' | 'done' | 'error' | 'locked'

export function SceneImage({
  cacheKey,
  chapterText,
  chapterTitle,
  chapterSummary,
  characters = [],
  autoGenerate = false
}: Props) {
  const health = useStore((s) => s.health)
  const toast = useStore((s) => s.toast)
  const [status, setStatus] = useState<Status>('checking')
  const [src, setSrc] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [lastPrompt, setLastPrompt] = useState('')
  const checked = useRef(false)

  const fbReady = canImage(health)
  const gcReady = canChat(health)

  useEffect(() => {
    if (checked.current) return
    checked.current = true
    ;(async () => {
      const cached = await window.narra.getCachedImage(cacheKey)
      if (cached.ok) {
        setSrc(cached.data!.dataUrl)
        setStatus('done')
      } else {
        setStatus(fbReady ? 'empty' : 'locked')
        if (fbReady && autoGenerate) generate()
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, fbReady])

  async function generate(force = false) {
    setErr('')
    // 1) LLM-разбор фрагмента: что происходит + кто РЕАЛЬНО в кадре, позы, одежда из текста
    let ctx = chapterSummary
    let present: ScenePerson[] = presentIn(chapterText, characters).map((c) => ({ char: c }))
    if (gcReady) {
      setStatus('thinking')
      const roster = characters.map((c) => ({ id: c.id, name: c.name, fullName: c.fullName }))
      const p = await window.narra.llmText(sceneAnalysisRequest(chapterText, roster), 0.3)
      if (p.ok) {
        try {
          const m = p.data!.text.match(/\{[\s\S]*\}/)
          const j = JSON.parse(m ? m[0] : p.data!.text) as {
            scene?: string
            people?: { id: string; action?: string; outfit?: string | null }[]
          }
          if (j.scene?.trim()) ctx = j.scene.trim()
          if (Array.isArray(j.people)) {
            const byId = new Map(characters.map((c) => [c.id, c]))
            const parsed = j.people
              .filter((pp) => byId.has(pp.id))
              .map((pp) => ({ char: byId.get(pp.id)!, action: pp.action, outfit: pp.outfit }))
            present = parsed // пусто — значит в кадре правда никого из героев
          }
        } catch {
          /* кривой JSON — остаёмся на presentIn-фолбэке */
        }
      }
    }
    const prompt = scenePrompt(ctx, present)
    setLastPrompt(prompt)
    // 2) генерация — сцены рисует Kandinsky: он точнее следует составу кадра и одежде
    setStatus('drawing')
    const img = await window.narra.generateImage(prompt, cacheKey, 1280, 768, force, 'kandinsky')
    if (img.ok) {
      setSrc(img.data!.dataUrl)
      setStatus('done')
    } else {
      setErr(img.error || 'Ошибка')
      setStatus('error')
      toast({ type: 'error', title: 'Не удалось нарисовать сцену', message: img.error, onRetry: () => generate(force) })
    }
  }

  function showPrompt() {
    toast({
      type: 'info',
      title: 'Промпт этой картинки',
      message: (lastPrompt || 'Промпт не сохранён (картинка из кэша). Нажми ↻ — и он появится.').slice(0, 600)
    })
  }

  if (status === 'done' && src) {
    return (
      <figure className="scene-figure">
        <img src={src} alt={`Сцена: ${chapterTitle}`} />
        <figcaption>
          <span>Сцена — сгенерировано ИИ</span>
          <span className="scene-figure__tools">
            <button onClick={() => generate(true)} title="Перегенерировать">↻</button>
            <button onClick={showPrompt} title="Показать промпт">почему так?</button>
          </span>
        </figcaption>
      </figure>
    )
  }

  if (status === 'checking') return null

  if (status === 'locked') {
    return <div className="scene-cta scene-cta--locked">Иллюстрации сейчас недоступны</div>
  }

  if (status === 'thinking' || status === 'drawing') {
    return (
      <div className="scene-figure scene-figure--loading">
        <div className="shimmer" style={{ position: 'absolute', inset: 0, borderRadius: 18 }}>
          <div className="skeleton-note">
            <span className="spark">✦</span>
            <span>
              {status === 'thinking' ? 'Собираем сцену…' : 'Рисуем сцену…'}
              <br />
              20–60 секунд
            </span>
          </div>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <button className="scene-cta scene-cta--error" onClick={() => generate()}>
        {err} · повторить
      </button>
    )
  }

  return (
    <button className="scene-cta" onClick={() => generate()}>
      ✦ Показать сцену
    </button>
  )
}
