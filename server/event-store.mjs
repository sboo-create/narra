import { mkdir, appendFile } from 'node:fs/promises'
import path from 'node:path'

export function createEventStore({ dataDir, environment = 'production' }) {
  const file = path.join(dataDir, `events-${environment}.jsonl`)
  let chain = Promise.resolve()
  return {
    file,
    async append(events) {
      const write = async () => {
        await mkdir(dataDir, { recursive: true, mode: 0o700 })
        const payload = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
        await appendFile(file, payload, { encoding: 'utf8', mode: 0o600 })
      }
      const pending = chain.then(write, write)
      chain = pending.catch(() => {})
      await pending
    }
  }
}
