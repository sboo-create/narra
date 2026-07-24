import { useState } from 'react'
import { suspendStatePersistence, useStore } from '../store/useStore'

export function Settings() {
  const settings = useStore((s) => s.settings)
  const health = useStore((s) => s.health)
  const checkingHealth = useStore((s) => s.checkingHealth)
  const reloadSettings = useStore((s) => s.reloadSettings)
  const checkHealth = useStore((s) => s.checkHealth)
  const toast = useStore((s) => s.toast)

  const [proxyUrl, setProxyUrl] = useState(settings?.proxyUrl || '')
  const [extendedTelemetryEnabled, setExtendedTelemetryEnabled] = useState(
    settings?.extendedTelemetryEnabled ?? true
  )
  const [saved, setSaved] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function save() {
    try {
      await window.narra.setSettings({ proxyUrl: proxyUrl.trim(), extendedTelemetryEnabled })
      await reloadSettings()
      setSaved(true)
      setTimeout(() => setSaved(false), 1600)
    } catch (error) {
      toast({ type: 'error', title: 'Адрес gateway не сохранён', message: (error as Error).message })
    }
  }

  async function test() {
    await save()
    await checkHealth()
    const h = useStore.getState().health
    if (h) toast({ type: 'success', title: 'Сервер отвечает' })
    else toast({ type: 'error', title: 'Нет связи с сервером', message: 'Проверь URL и что прокси запущен.' })
  }

  async function deleteLocalData() {
    if (!window.confirm('Удалить все локальные книги, заметки, чаты, медиа-кэши и служебную очередь Narra? Это действие нельзя отменить.')) return
    setDeleting(true)
    await suspendStatePersistence()
    const result = await window.narra.deleteAllLocalData()
    if (!result.ok) {
      setDeleting(false)
      toast({ type: 'error', title: 'Данные не удалены', message: result.error })
      return
    }
    window.location.reload()
  }

  const services = [
    { key: 'gigachat', label: 'AI — Giga / OpenRouter', on: !!health?.gigachat },
    { key: 'salutespeech', label: 'SaluteSpeech — эмоциональная озвучка', on: !!health?.salutespeech },
    { key: 'kandinsky', label: 'Kandinsky — изображения', on: !!health?.kandinsky },
    { key: 'video', label: 'Kandinsky video — аватары и анимация', on: !!health?.video }
  ]

  return (
    <div className="page" style={{ maxWidth: 780 }}>
      <div className="page__head">
        <div className="page__title">Настройки</div>
        <div className="page__subtitle">
          Ключи хранятся на сервере (прокси), не в приложении. Здесь — только адрес сервера.
        </div>
      </div>

      <div className="card settings-block">
        <div className="settings-block__head">
          <h3>Сервер (прокси)</h3>
          <span className={`chip ${health ? 'chip--accent' : ''}`}>
            {checkingHealth ? 'проверка…' : health ? <><span className="dot-online" /> подключён</> : 'не подключён'}
          </span>
        </div>
        <label className="field">
          <span>URL прокси-сервера</span>
          <input
            type="text"
            value={proxyUrl}
            placeholder="http://localhost:8787 или https://…railway.app"
            onChange={(e) => setProxyUrl(e.target.value)}
          />
        </label>
        <div className="settings-block__actions">
          <button className="btn btn--primary btn--sm" onClick={test} disabled={checkingHealth}>
            {checkingHealth ? 'Проверяем…' : 'Проверить подключение'}
          </button>
          <button className="btn btn--ghost btn--sm" onClick={save}>
            {saved ? '✓ Сохранено' : 'Сохранить'}
          </button>
        </div>

        <div className="services">
          {services.map((s) => (
            <div key={s.key} className="service-row">
              <span className={`dot-online ${s.on ? '' : 'dot-online--off'}`} />
              <span className={s.on ? '' : 'service-off'}>{s.label}</span>
              <span className="service-state">{s.on ? 'вкл' : 'выкл'}</span>
            </div>
          ))}
        </div>

        <div className="settings-block__sub" style={{ marginTop: 14 }}>
          Локально: из корня репозитория запусти <code>npm run proxy</code> и впиши ключи в{' '}
          <code>server/.env</code>. Для раздачи приложения задеплой <code>server/</code> на Railway
          и укажи здесь его URL — тогда у всех получателей всё работает без ключей.
        </div>
      </div>

      <div className="card settings-block">
        <div className="settings-block__head">
          <h3>Расширенная аналитика</h3>
          <span className={`chip ${extendedTelemetryEnabled ? 'chip--accent' : ''}`}>
            {extendedTelemetryEnabled ? 'включена' : 'выключена'}
          </span>
        </div>
        <label className="service-row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={extendedTelemetryEnabled}
            onChange={(event) => setExtendedTelemetryEnabled(event.target.checked)}
          />
          <span>Отправлять детальную обезличенную статистику функций и чтения</span>
        </label>
        <div className="settings-block__sub" style={{ marginTop: 12 }}>
          Даже при выключении остаётся минимальная служебная статистика: активная установка,
          версия, квалифицированное чтение, AI-запросы без содержимого, ошибки и обновления.
          Никогда не отправляются тексты книг, названия и файлы, заметки, переписка, промпты,
          ответы, изображения, аудио или видео.
        </div>
      </div>

      <div className="card settings-block">
        <div className="settings-block__head">
          <h3>Локальные данные</h3>
        </div>
        <div className="settings-block__sub">
          Удаляет импортированные книги, прогресс, заметки, чаты и память персонажей,
          изображения, аудио, видео, очередь статистики и локальный токен gateway.
        </div>
        <div className="settings-block__actions" style={{ marginTop: 14 }}>
          <button className="btn btn--ghost btn--sm" onClick={deleteLocalData} disabled={deleting}>
            {deleting ? 'Удаляем…' : 'Удалить все локальные данные'}
          </button>
        </div>
      </div>
    </div>
  )
}
