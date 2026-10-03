import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LinuxTreeWatcher, shouldWatchDir } from '../../src/main/linuxTreeWatch'

describe('shouldWatchDir', () => {
  it('重いフォルダには降りないが、指摘の進み具合の置き場までは降りる', () => {
    expect(shouldWatchDir('')).toBe(true)
    expect(shouldWatchDir('src/components')).toBe(true)
    expect(shouldWatchDir('node_modules')).toBe(false)
    expect(shouldWatchDir('packages/a/node_modules')).toBe(false)
    expect(shouldWatchDir('.git')).toBe(false)
    expect(shouldWatchDir('.ferret')).toBe(true)
    expect(shouldWatchDir('.ferret/reviews')).toBe(true)
    expect(shouldWatchDir('.ferret/reviews/20261003-120000')).toBe(true)
    expect(shouldWatchDir('.ferret/reviews/20261003-120000/shots')).toBe(false)
    expect(shouldWatchDir('.ferret/recordings')).toBe(false)
  })
})

describe('LinuxTreeWatcher', () => {
  let root = ''
  let watcher: LinuxTreeWatcher | null = null
  afterEach(async () => {
    watcher?.close()
    if (root) await rm(root, { recursive: true, force: true })
  })

  const until = async (check: () => boolean): Promise<void> => {
    const deadline = Date.now() + 3000
    while (!check() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25))
  }

  // Linux でだけ使う見張り。Windows は見張り中のフォルダの消し方・通知の出方が違うので流さない（files.ts は Windows では recursive を使う）
  it.skipIf(process.platform === 'win32')('対象のフォルダの変更を拾い、node_modules は見張らない。あとから作ったフォルダも見張る', async () => {
    root = await mkdtemp(join(tmpdir(), 'tree-watch-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    const seen = new Set<string>()
    watcher = new LinuxTreeWatcher(root, (_event, name) => seen.add(name))
    await until(() => watcher!.size === 2)
    expect(watcher.size).toBe(2) // 直下と src

    await writeFile(join(root, 'src', 'a.ts'), 'x')
    await until(() => seen.has('src/a.ts'))
    expect(seen.has('src/a.ts')).toBe(true)

    await mkdir(join(root, 'lib'))
    await until(() => watcher!.size === 3)
    await writeFile(join(root, 'lib', 'b.ts'), 'x')
    await until(() => seen.has('lib/b.ts'))
    expect(seen.has('lib/b.ts')).toBe(true)

    await writeFile(join(root, 'node_modules', 'pkg', 'c.js'), 'x')
    await new Promise((done) => setTimeout(done, 200))
    expect([...seen].some((name) => name.startsWith('node_modules/pkg'))).toBe(false)

    await rm(join(root, 'lib'), { recursive: true })
    await until(() => watcher!.size === 2)
    expect(watcher.size).toBe(2)
  })
})
