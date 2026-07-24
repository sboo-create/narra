const BOOTSTRAP_CHARS = 900
const REGULAR_CHARS = 3500

function preferredCut(text: string, maxChars: number): number {
  const window = text.slice(0, maxChars + 1)
  const sentenceBreak = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
    window.lastIndexOf('… ')
  )
  const whitespaceBreak = window.lastIndexOf(' ')
  if (sentenceBreak >= Math.floor(maxChars * 0.55)) return sentenceBreak + 1
  if (whitespaceBreak >= Math.floor(maxChars * 0.55)) return whitespaceBreak
  return maxChars
}

/**
 * The first request is deliberately small so an imported book can get its
 * first playable part quickly. Remaining chunks are larger.
 */
export function progressiveChapterChunks(text: string): string[] {
  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean)
  const chunks: string[] = []
  let cur = ''
  for (const paragraph of paragraphs) {
    let rest = paragraph
    let continuation = false
    while (rest) {
      const currentMax = chunks.length === 0 ? BOOTSTRAP_CHARS : REGULAR_CHARS
      const separator = cur ? (continuation ? ' ' : '\n\n') : ''
      const available = currentMax - cur.length - separator.length
      if (available <= 0) {
        chunks.push(cur)
        cur = ''
        continue
      }
      if (rest.length <= available) {
        cur = `${cur}${separator}${rest}`
        rest = ''
        continue
      }
      // Do not create a tiny paragraph fragment only to fill the previous
      // chunk; close that chunk and let the new one use its full allowance.
      if (cur && available < Math.floor(currentMax * 0.25)) {
        chunks.push(cur)
        cur = ''
        continue
      }
      const cut = preferredCut(rest, available)
      cur = `${cur}${separator}${rest.slice(0, cut).trim()}`
      rest = rest.slice(cut).trim()
      continuation = true
      chunks.push(cur)
      cur = ''
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}
