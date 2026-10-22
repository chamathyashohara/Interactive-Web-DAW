import { build } from 'esbuild'
import { cp, mkdir } from 'node:fs/promises'

await mkdir('dist', { recursive: true })
await Promise.all([
  build({ entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', bundle: true, platform: 'node', external: ['electron'], format: 'cjs' }),
  build({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.js', bundle: true, platform: 'node', external: ['electron'], format: 'cjs' }),
  build({ entryPoints: ['src/renderer/renderer.ts'], outfile: 'dist/renderer.js', bundle: true, platform: 'browser', format: 'iife' }),
  cp('src/renderer/index.html', 'dist/index.html'),
])
console.log('built')
