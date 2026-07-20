import { GeneratedImage } from './GeneratedImage'
import type { Emotion } from '@shared/types'

interface Props {
  cacheKey: string
  prompt: string
  speaking?: boolean
  emotion?: Emotion
  className?: string
  rounded?: number
  width?: number
  height?: number
  lockedHint?: string
}

// Стабильный портрет в фиксированной рамке (без трансформаций — ничего не «съезжает»).
// Реакция без движения: свечение при речи + лёгкий цвет эмоции.
// Настоящая анимация появится через видео Kandinsky (заменим на <video>).
export function LivingPortrait({
  cacheKey,
  prompt,
  speaking = false,
  emotion = 'neutral',
  className,
  rounded = 20,
  width = 1024,
  height = 1024,
  lockedHint
}: Props) {
  return (
    <div
      className={`living emo-${emotion} ${speaking ? 'is-speaking' : ''} ${className || ''}`}
      style={{ borderRadius: rounded }}
    >
      <div className="living__glow" style={{ borderRadius: rounded }} />
      <GeneratedImage
        cacheKey={cacheKey}
        prompt={prompt}
        width={width}
        height={height}
        rounded={rounded}
        className="living__img"
        lockedHint={lockedHint}
      />
      <div className="living__grade" style={{ borderRadius: rounded }} />
    </div>
  )
}
