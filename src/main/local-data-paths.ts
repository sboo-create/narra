import path from 'node:path'

const OWNED_DIRECTORIES = ['books', 'images', 'audio', 'video'] as const

export function ownedLocalDataDirectories(userData: string): string[] {
  const root = path.resolve(userData)
  if (root === path.parse(root).root) throw new Error('Refusing a filesystem root as userData')
  return OWNED_DIRECTORIES.map((name) => {
    const target = path.resolve(root, name)
    if (path.dirname(target) !== root) throw new Error('Unsafe local-data path')
    return target
  })
}
