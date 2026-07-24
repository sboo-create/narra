export function validateArchiveEntry(
  rawPath: unknown,
  externalFileAttributes: unknown,
  entryCount: number,
  maxEntries: number
): string {
  const normalized = String(rawPath || '').replace(/\\/g, '/')
  const parts = normalized.split('/')
  const unixType = (Number(externalFileAttributes || 0) >>> 16) & 0o170000
  if (
    entryCount > maxEntries || !normalized || normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) || normalized.length > 500 || normalized.includes('\0') ||
    parts.some((part, index) => part === '..' || part === '.' || (!part && index !== parts.length - 1)) ||
    unixType === 0o120000
  ) {
    throw new Error('Архив содержит небезопасный путь или ссылку')
  }
  return normalized
}

export class ArchiveByteQuota {
  private used = 0
  private readonly maxBytes: number
  private readonly ratioLimit: number

  constructor(maxBytes: number, ratioLimit: number) {
    this.maxBytes = maxBytes
    this.ratioLimit = ratioLimit
  }

  add(bytes: number): void {
    this.used += bytes
    if (this.used > this.maxBytes || this.used > this.ratioLimit) {
      throw new Error('Распакованный архив превышает byte/ratio лимит')
    }
  }
}
