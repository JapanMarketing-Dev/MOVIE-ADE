import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IPC_EVENT_CHANNELS, IPC_REQUEST_CHANNELS } from '@shared/ipc'

/**
 * renderer が使う IPC のチャネルが、preload の許可リスト（src/shared/ipc.ts）にすべて載っているか。
 * 載っていないと preload が「未宣言のIPCイベント／チャネル」で断る（Sentry MOVIE-ADE-N の star:show）。
 * 型（satisfies）は「許可リストが宣言の中にあるか」しか見ないので、逆向きの漏れをここで拾う。
 */

const ROOT = resolve(__dirname, '../..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

const files = sourceFiles(join(ROOT, 'src/renderer'))
const texts = files.map((file) => ({ file: file.slice(ROOT.length + 1), text: readFileSync(file, 'utf8') }))

/** `window.ade.on('x'` / `subscribeIpc('x'` / `.invoke('x'` の 'x' を集める */
function channelsUsed(pattern: RegExp): Array<{ channel: string; file: string }> {
  return texts.flatMap(({ file, text }) => [...text.matchAll(pattern)].map((m) => ({ channel: m[1]!, file })))
}

describe('IPC の許可リスト', () => {
  it('renderer が購読するイベントは、すべて許可リストにある', () => {
    const used = channelsUsed(/(?:\bade\.on|\bsubscribeIpc)\(\s*'([a-zA-Z]+:[a-zA-Z]+)'/g)
    expect(used.length).toBeGreaterThan(0)
    const allowed = new Set<string>(IPC_EVENT_CHANNELS)
    expect(used.filter((u) => !allowed.has(u.channel))).toEqual([])
  })

  it('renderer が呼ぶチャネルは、すべて許可リストにある', () => {
    const used = channelsUsed(/\.invoke\(\s*'([a-zA-Z]+:[a-zA-Z]+)'/g)
    expect(used.length).toBeGreaterThan(0)
    const allowed = new Set<string>(IPC_REQUEST_CHANNELS)
    expect(used.filter((u) => !allowed.has(u.channel))).toEqual([])
  })

  it('star のお願いのチャネルが載っている', () => {
    expect(IPC_EVENT_CHANNELS).toContain('star:show')
    expect(IPC_REQUEST_CHANNELS).toEqual(expect.arrayContaining(['star:star', 'star:openWeb', 'star:later', 'star:never', 'star:fromMenu']))
  })
})

describe('preload の購読（古い preload でも画面を落とさない）', () => {
  it('宣言の無いイベントでも投げず、何もしない購読解除を返す（Sentry FERRET-S / FERRET-T）', () => {
    const text = readFileSync(join(ROOT, 'src/preload/index.ts'), 'utf8')
    const on = text.slice(text.indexOf('  on: <C extends IpcEventChannel>'), text.indexOf('  platform: process.platform'))
    expect(on).toContain('return () => {}')
    expect(on).not.toMatch(/throw new Error/)
  })
})
