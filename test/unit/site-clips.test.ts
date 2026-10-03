import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** docs の機能動画（site/docs/assets/clips/）は 1.5MB 未満で、同じ名前の poster（.webp）を持つ */
const CLIPS = resolve(__dirname, '../../site/docs/assets/clips')
const clips = existsSync(CLIPS) ? readdirSync(CLIPS).filter((f) => f.endsWith('.mp4')) : []

describe('site/docs/assets/clips', () => {
  it.each(clips.length ? clips : ['(none)'])('%s', (name) => {
    if (name === '(none)') return
    expect(statSync(join(CLIPS, name)).size).toBeLessThan(1.5 * 1024 * 1024)
    expect(existsSync(join(CLIPS, name.replace(/\.mp4$/, '.webp')))).toBe(true)
  })
})
