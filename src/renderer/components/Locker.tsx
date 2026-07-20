import { useStore } from '../store/useStore'

export function Locker({ text }: { text?: string }) {
  const navigate = useStore((s) => s.navigate)
  return (
    <div className="locker">
      <div className="locker__icon">🔒</div>
      <div style={{ flex: 1 }}>
        <strong>AI-функция недоступна.</strong>{' '}
        {text || 'Проверь подключение к серверу в настройках, чтобы оживить книгу.'}
      </div>
      <button className="btn btn--ghost btn--sm" onClick={() => navigate({ name: 'settings' })}>
        Открыть настройки
      </button>
    </div>
  )
}
