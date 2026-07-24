import { parentPort } from 'node:worker_threads'

interface PdfWorkerRequest {
  bytes: Uint8Array
}

if (!parentPort) throw new Error('PDF worker requires a parent port')

parentPort.once('message', async (message: PdfWorkerRequest) => {
  let parser: import('pdf-parse').PDFParse | undefined
  try {
    if (!(message?.bytes instanceof Uint8Array) || message.bytes.byteLength > 40 * 1024 * 1024) {
      throw new Error('PDF input exceeds the worker limit')
    }
    // Keep the parser inside this resource-limited worker. v2 uses current
    // PDF.js and disables the vulnerable legacy parser bundled by v1.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PDFParse } = require('pdf-parse') as typeof import('pdf-parse')
    parser = new PDFParse({ data: Buffer.from(message.bytes) })
    const textResult = await parser.getText()
    const infoResult = await parser.getInfo()
    const text = String(textResult.text || '')
    if (text.length > 20_000_000) throw new Error('PDF extracted text exceeds the worker limit')
    const info = infoResult.info as { Title?: unknown; Author?: unknown } | undefined
    parentPort!.postMessage({
      ok: true,
      text,
      title: typeof info?.Title === 'string' ? info.Title.slice(0, 300) : '',
      author: typeof info?.Author === 'string' ? info.Author.slice(0, 300) : ''
    })
  } catch {
    parentPort!.postMessage({ ok: false, error: 'Не удалось безопасно разобрать PDF' })
  } finally {
    await parser?.destroy().catch(() => {})
  }
})
