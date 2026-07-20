// Знак narra — вариант 1e «ночное чтение» из дизайн-проекта:
// чёрный квадрат, белая книжка-крыша, лаймовые зрачки и улыбка.
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <div className="logo-mark" style={{ width: size, height: size }}>
      <svg viewBox="0 0 96 96" width="82%" height="82%">
        <rect x="43" y="14" width="11" height="8" rx="3.5" fill="#ffffff" />
        <g fill="none" stroke="#ffffff" strokeLinecap="round">
          <path d="M46,20 C34,26 22,34 14,41" strokeWidth="6.5" />
          <path d="M51,20 C63,26 75,34 83,41" strokeWidth="6.5" />
          <path d="M45,27 C35,32 26,38 19,44" strokeWidth="3" />
          <path d="M52,27 C62,32 71,38 78,44" strokeWidth="3" />
        </g>
        <path
          d="M44,68 C46.5,70 50.5,70 53,68"
          fill="none"
          stroke="#d8ff3d"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="40" cy="56" r="4.5" fill="#141414" stroke="#ffffff" strokeWidth="3" />
        <circle cx="57" cy="56" r="4.5" fill="#141414" stroke="#ffffff" strokeWidth="3" />
        <circle cx="39" cy="54" r="1.8" fill="#d8ff3d" />
        <circle cx="56" cy="54" r="1.8" fill="#d8ff3d" />
      </svg>
    </div>
  )
}
