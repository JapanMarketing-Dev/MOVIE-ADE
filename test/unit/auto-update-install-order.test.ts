import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nsisInstallerArgs } from '../../src/shared/appUpdate'

/**
 * Windows の［再起動して更新］の順序（FERRET-1Q の再発防止）。
 * 0.4.16〜0.4.18 は NSIS のインストーラーを先に起動してから app.quit() していた。--updated のインストーラーは約1.3秒後に
 * インストール先の下のプロセスを止めにくるので、終了の後始末（PTY を閉じる・タブを書く）の途中の main に割り込んでいた。
 * いまは app.quit() だけを呼び、インストーラーは app の quit（後始末が済んだあと）で runPendingInstall が起動する
 */

const events: string[] = []
vi.mock('electron', () => ({
  app: { quit: () => { events.push('app.quit') }, getVersion: () => '0.0.1' },
  autoUpdater: { quitAndInstall: () => { events.push('quitAndInstall') } },
  shell: {}
}))
vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[]) => {
    events.push(`spawn ${args.join(' ')}`)
    return { once: () => undefined, unref: () => undefined, file }
  }
}))

const { installUpdate, runPendingInstall } = await import('../../src/main/autoUpdateInstall')

describe('［再起動して更新］（NSIS）は、終了の後始末が済んでからインストーラーを起動する', () => {
  let dir = ''
  const body = 'installer body'
  const file = { version: '2.0.0', name: 'Ferret-2.0.0-win-x64.exe', sha256: createHash('sha256').update(body).digest('hex'), size: body.length, kind: 'exe', url: 'https://example.invalid/x.exe' }
  beforeEach(() => {
    events.length = 0
    dir = mkdtempSync(join(tmpdir(), 'ferret-order-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('installUpdate は app.quit() だけを呼び、インストーラーはまだ起動しない。quit で1回だけ起動する（--force-run 付き）', async () => {
    const path = join(dir, file.name)
    writeFileSync(path, body)
    await installUpdate('nsis', path, file as never)
    expect(events).toEqual(['app.quit'])
    expect(runPendingInstall()).toBe(true)
    expect(events).toEqual(['app.quit', `spawn ${nsisInstallerArgs('restart').join(' ')}`])
    expect(runPendingInstall()).toBe(false)
  })

  it('［再起動して更新］を押していなければ、quit では何もしない', () => {
    expect(runPendingInstall()).toBe(false)
    expect(events).toEqual([])
  })

  it('押してから quit までに中身が変わっていれば起動しない', async () => {
    const path = join(dir, file.name)
    writeFileSync(path, body)
    await installUpdate('nsis', path, file as never)
    writeFileSync(path, 'swapped')
    expect(() => runPendingInstall()).toThrow()
    expect(events).toEqual(['app.quit'])
    // 1回で捨てる（次の quit でまた試さない）
    expect(runPendingInstall()).toBe(false)
  })
})
