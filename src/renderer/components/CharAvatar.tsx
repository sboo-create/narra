import { useEffect, useState } from 'react'

interface Props {
  cacheKey: string
  name: string
  size?: number
  className?: string
}

// Круглая аватарка персонажа: показывает кэшированный портрет, иначе — букву.
export function CharAvatar({ cacheKey, name, size = 34, className }: Props) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.narra.getCachedImage(cacheKey).then((r) => {
      if (alive && r.ok) setSrc(r.data!.dataUrl)
    })
    return () => {
      alive = false
    }
  }, [cacheKey])

  return (
    <span className={`avatar ${className || ''}`} style={{ width: size, height: size }}>
      {src ? <img src={src} alt={name} /> : <span className="avatar__letter">{name[0]}</span>}
    </span>
  )
}
