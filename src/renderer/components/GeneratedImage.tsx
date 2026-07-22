import { useEffect, useRef, useState } from 'react'
import { useStore, canImage } from '../store/useStore'

interface Props {
  cacheKey: string
  prompt: string
  width?: number
  height?: number
  className?: string
  /** авто-генерировать при наличии ключей, если нет в кэше */
  auto?: boolean
  /** подпись-плейсхолдер без ключей */
  lockedHint?: string
  rounded?: number
  /** движок генерации: 'kandinsky' — рисованный стиль (портреты, обложки, сцены) */
  engine?: 'kandinsky'
  /** показывать кнопку «нарисовать заново» */
  regenerable?: boolean
}

type Status = 'idle' | 'checking' | 'generating' | 'done' | 'error' | 'locked'

export function GeneratedImage({
  cacheKey,
  prompt,
  width = 768,
  height = 1024,
  className,
  auto = true,
  lockedHint = 'Генерация картинок недоступна',
  rounded,
  engine,
  regenerable = false
}: Props) {
  const health = useStore((s) => s.health)
  const markGenerated = useStore((s) => s.markGenerated)
  const [status, setStatus] = useState<Status>('checking')
  const [src, setSrc] = useState<string | null>(null)
  const [err, setErr] = useState<string>('')
  const startedRef = useRef(false)

  const keys = canImage(health)

  async function generate(force = false) {
    setStatus('generating')
    setErr('')
    const res = await window.narra.generateImage(prompt, cacheKey, width, height, force, engine)
    if (res.ok) {
      setSrc(res.data!.dataUrl)
      setStatus('done')
      markGenerated(cacheKey)
    } else {
      setErr(res.error || 'Ошибка генерации')
      setStatus('error')
    }
  }

  useEffect(() => {
    let alive = true
    ;(async () => {
      setStatus('checking')
      const cached = await window.narra.getCachedImage(cacheKey)
      if (!alive) return
      if (cached.ok) {
        setSrc(cached.data!.dataUrl)
        setStatus('done')
        return
      }
      if (!keys) {
        setStatus('locked')
        return
      }
      if (auto && !startedRef.current) {
        startedRef.current = true
        generate()
      } else {
        setStatus('idle')
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, keys])

  const style = rounded ? { borderRadius: rounded } : undefined

  if (status === 'done' && src) {
    if (!regenerable) return <img src={src} className={className} style={style} alt="" />
    return (
      <span className="genimg">
        <img src={src} className={className} style={style} alt="" />
        <button
          className="genimg__redraw"
          title="Нарисовать заново"
          onClick={(e) => {
            e.stopPropagation()
            generate(true)
          }}
        >
          ↻
        </button>
      </span>
    )
  }

  return (
    <div className={`gen-image ${className || ''}`} style={style}>
      {(status === 'checking' || status === 'generating') && (
        <div className="shimmer" style={{ position: 'absolute', inset: 0, borderRadius: 'inherit' }}>
          <div className="skeleton-note">
            <span className="spark">✦</span>
            {status === 'generating' ? (
              <span>Рисуем сцену…<br />обычно 10–20 секунд</span>
            ) : (
              <span>Загрузка…</span>
            )}
          </div>
        </div>
      )}
      {status === 'locked' && (
        <div className="skeleton-note" style={{ position: 'absolute', inset: 0 }}>
          <span className="spark" style={{ opacity: 0.6 }}>🔒</span>
          <span>{lockedHint}</span>
        </div>
      )}
      {status === 'idle' && (
        <div className="skeleton-note" style={{ position: 'absolute', inset: 0 }}>
          <button className="btn btn--ghost btn--sm" onClick={() => generate()}>
            ✦ Сгенерировать
          </button>
        </div>
      )}
      {status === 'error' && (
        <div className="skeleton-note" style={{ position: 'absolute', inset: 0 }}>
          <span className="spark" style={{ opacity: 0.6 }}>⚠️</span>
          <span style={{ fontSize: 12 }}>{err}</span>
          <button className="btn btn--ghost btn--sm" onClick={() => generate()}>
            ↻ Повторить
          </button>
        </div>
      )}
    </div>
  )
}
