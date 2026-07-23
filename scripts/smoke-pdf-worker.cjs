const { app } = require('electron')
const { Worker } = require('node:worker_threads')
const path = require('node:path')

function tinyPdf(text) {
  const stream = `BT /F1 18 Tf 72 100 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(body))
}

function runWorker(workerPath, bytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 }
    })
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error('PDF worker smoke timed out'))
    }, 15_000)
    worker.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    worker.once('message', (message) => {
      clearTimeout(timer)
      void worker.terminate().finally(() => resolve(message))
    })
    worker.postMessage({ bytes })
  })
}

app.whenReady().then(async () => {
  const workerPath = path.resolve(
    process.argv[2] || 'release/mac-universal/Narra.app/Contents/Resources/app.asar/out/main/pdf-worker.js'
  )
  try {
    const valid = await runWorker(workerPath, tinyPdf('Narra smoke'))
    if (!valid?.ok || !String(valid.text).includes('Narra smoke')) {
      throw new Error(`valid PDF was not parsed: ${JSON.stringify(valid)}`)
    }
    const invalid = await runWorker(workerPath, new Uint8Array([0x25, 0x50, 0x44, 0x46]))
    if (invalid?.ok !== false || typeof invalid.error !== 'string') {
      throw new Error(`invalid PDF was not rejected safely: ${JSON.stringify(invalid)}`)
    }
    console.log('Packaged PDF worker parsed a real PDF and rejected invalid input safely')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
