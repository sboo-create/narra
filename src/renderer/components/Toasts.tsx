import { useStore } from '../store/useStore'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)

  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.type}`}>
          <div className="toast__icon">
            {t.type === 'error' ? '⚠️' : t.type === 'success' ? '✓' : '✦'}
          </div>
          <div className="toast__body">
            <div className="toast__title">{t.title}</div>
            {t.message && <div className="toast__msg">{t.message}</div>}
            {t.onRetry && (
              <button
                className="toast__retry"
                onClick={() => {
                  dismiss(t.id)
                  t.onRetry?.()
                }}
              >
                {t.actionLabel || '↻ Повторить'}
              </button>
            )}
          </div>
          <button className="toast__retry" style={{ marginTop: 0 }} onClick={() => dismiss(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
