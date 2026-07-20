import { cp, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
await mkdir(resolve(root, 'dist-mobile/content'), { recursive: true })
await cp(resolve(root, 'content'), resolve(root, 'dist-mobile/content'), {
  recursive: true,
  force: true
})

console.log('✓ dist-mobile/content')
