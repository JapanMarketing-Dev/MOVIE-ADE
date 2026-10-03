import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { APP_TABS, drawApp, drawScene, sceneNames } from '../../site/js/scenes.js'
import { posterStamp } from '../../tools/docs/poster-stamp.mjs'

/** LP の各節のアニメーション（site/js/scenes.js）が、どの時点・静止画でも例外なく描けること */
function fakeContext() {
  return new Proxy({} as Record<string, unknown>, {
    get(target, key) {
      if (key === 'measureText') return (s: string) => ({ width: String(s).length * 8 })
      if (key in target) return target[key as string]
      return () => {}
    },
    set(target, key, value) {
      target[key as string] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

describe('site/js/scenes.js', () => {
  it('2つの節がそろっている', () => {
    expect(sceneNames).toEqual(['text', 'many'])
  })
  it.each(sceneNames)('%s は 0〜8 秒のどこでも、静止画でも描ける', (name) => {
    const ctx = fakeContext()
    for (let t = 0; t <= 8; t += 0.25) expect(() => drawScene(ctx, name, t)).not.toThrow()
    expect(() => drawScene(ctx, name, 0, true)).not.toThrow()
  })
  it.each(APP_TABS)('製品デモのタブ %s は 0〜7 秒のどこでも、静止画でも描ける', (tab) => {
    const ctx = fakeContext()
    for (let t = 0; t <= 7; t += 0.25) expect(() => drawApp(ctx, tab, t)).not.toThrow()
    expect(() => drawApp(ctx, tab, 0, true)).not.toThrow()
  })
  it('静止画（site/assets の hero-poster・scenes・demo）が今の JS から描かれている。違うなら node tools/docs/render-hero.mjs', () => {
    const stamp = JSON.parse(readFileSync(resolve(__dirname, '../../tools/docs/poster-stamp.json'), 'utf8'))
    expect(stamp).toEqual(posterStamp())
  })
})
