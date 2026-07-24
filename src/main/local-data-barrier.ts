let resetting = false
let inFlightWrites = 0
const idleWaiters = new Set<() => void>()

export async function runLocalDataWrite<T>(operation: () => Promise<T>): Promise<T> {
  if (resetting) throw new Error('local data reset in progress')
  inFlightWrites += 1
  try {
    return await operation()
  } finally {
    inFlightWrites -= 1
    if (inFlightWrites === 0) {
      for (const resolve of idleWaiters) resolve()
      idleWaiters.clear()
    }
  }
}

export async function beginLocalDataReset(): Promise<void> {
  resetting = true
  if (inFlightWrites === 0) return
  await new Promise<void>((resolve) => idleWaiters.add(resolve))
}

export function isLocalDataResetting(): boolean {
  return resetting
}
