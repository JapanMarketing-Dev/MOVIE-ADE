import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/report', () => ({ reportPerf: vi.fn() }))

const { noteLaunchedVersion } = await import('../../src/main/startup')

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('noteLaunchedVersion（Sentry FERRET-1C: 更新直後の初回の起動の遅れ）', () => {
  it('初めて・版が変わった起動だけ true。覚えた版を書き直す', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-version-'))
    dirs.push(dir)
    const file = join(dir, 'sub', 'last-launch-version')
    expect(noteLaunchedVersion(file, '0.4.18')).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('0.4.18')
    expect(noteLaunchedVersion(file, '0.4.18')).toBe(false)
    expect(noteLaunchedVersion(file, '0.4.19')).toBe(true)
    expect(noteLaunchedVersion(file, '0.4.19')).toBe(false)
  })
})
