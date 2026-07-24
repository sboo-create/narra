type AppState = Record<string, unknown>
type MaybePromise<T> = T | Promise<T>

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function belongsToBook(key: string, bookId: string): boolean {
  return key === bookId ||
    key.startsWith(`${bookId}-`) ||
    key.startsWith(`${bookId}:`) ||
    key.includes(`-${bookId}-`)
}

/** Remove every renderer-persisted value that can contain data for one book. */
export function removeBookFromAppState(state: AppState, bookId: string): AppState {
  const next: AppState = { ...state }
  for (const field of ['chapters', 'bookmarks', 'notes']) {
    const values = { ...recordValue(next[field]) }
    delete values[bookId]
    next[field] = values
  }
  for (const field of [
    'chats', 'stats', 'versions', 'covers', 'summaries', 'scenarios',
    'voiceOverrides', 'memories', 'sceneAnchors', 'extraScenes', 'anchorLists'
  ]) {
    next[field] = Object.fromEntries(
      Object.entries(recordValue(next[field]))
        .filter(([key]) => !belongsToBook(key, bookId))
    )
  }
  if (!bookId.startsWith('u-')) {
    const hidden = Array.isArray(next.hiddenBooks)
      ? next.hiddenBooks.filter((value): value is string => typeof value === 'string')
      : []
    next.hiddenBooks = [...new Set([...hidden, bookId])]
  }
  return next
}

/**
 * Serializes whole-state renderer writes with long-running destructive
 * transactions. A successful deletion keeps its book id blocked for the rest
 * of the process, so a renderer snapshot queued during the deletion cannot
 * restore private book-owned state after the files are gone.
 */
export class AppStateCoordinator {
  private chain: Promise<unknown> = Promise.resolve()
  private readonly blockedBookIds = new Set<string>()
  private readonly read: () => MaybePromise<AppState>
  private readonly write: (next: AppState) => MaybePromise<void>

  constructor(
    read: () => MaybePromise<AppState>,
    write: (next: AppState) => MaybePromise<void>
  ) {
    this.read = read
    this.write = write
  }

  private sanitize(next: AppState): AppState {
    let sanitized = next
    for (const bookId of this.blockedBookIds) {
      sanitized = removeBookFromAppState(sanitized, bookId)
    }
    return sanitized
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(task)
    this.chain = next
    return next
  }

  replace(next: AppState): Promise<void> {
    return this.enqueue(async () => {
      await this.write(this.sanitize(next))
    })
  }

  transaction<T>(
    task: (
      current: AppState,
      commit: (next: AppState) => Promise<void>
    ) => Promise<T>
  ): Promise<T> {
    return this.enqueue(async () => {
      const current = this.sanitize(await this.read())
      return task(current, async (next) => {
        await this.write(this.sanitize(next))
      })
    })
  }

  blockBook(bookId: string): void {
    this.blockedBookIds.add(bookId)
  }

  unblockBook(bookId: string): void {
    this.blockedBookIds.delete(bookId)
  }

  clearBlocks(): void {
    this.blockedBookIds.clear()
  }
}
