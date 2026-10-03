// 静止画（hero-poster・scenes・demo）の元になった JS のハッシュ。render-hero.mjs が書き、テストが今の JS と比べる
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const JS = resolve(dirname(fileURLToPath(import.meta.url)), '../../site/js')

export function posterStamp() {
  const out = {}
  for (const f of ['hero.js', 'scenes.js']) out[f] = createHash('sha256').update(readFileSync(join(JS, f))).digest('hex').slice(0, 16)
  return out
}
