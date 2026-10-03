import { describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/types'
import {
  MAX_SESSION_FILES,
  decodeCenterTab,
  encodeCenterTab,
  isRecordableUrl,
  sanitizeProjectSession,
  sessionUrl,
  withProjectSession
} from '@shared/projectSession'

// settings.ts は保存先を決めるためだけに electron の app を読む。単体テストでは呼ばれない
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit' } }))
const { sanitize } = await import('../../src/main/settings')

const project = (patch: Partial<Project> = {}): Project => ({ id: 'a', name: 'app', folderPath: '/work/app', urls: [], ...patch })

describe('プロジェクトごとの作業の状態', () => {
  it('開く URL: 前に開いていた URL → 登録 URL の先頭 → 空の画面', () => {
    const urls = [{ id: 'l', label: 'local', url: 'http://localhost:3000' }]
    expect(sessionUrl(project({ urls, session: { url: 'http://localhost:3000/pricing' } }))).toBe('http://localhost:3000/pricing')
    expect(sessionUrl(project({ urls }))).toBe('http://localhost:3000')
    expect(sessionUrl(project())).toBe('about:blank')
    expect(isRecordableUrl('about:blank')).toBe(false)
    expect(isRecordableUrl('')).toBe(false)
    expect(isRecordableUrl('https://example.com')).toBe(true)
  })

  it('状態を重ねると、指定した項目だけ変わり、ほかのプロジェクトは変わらない。null / undefined は消す', () => {
    const projects = [project({ session: { url: 'http://a', centerTab: 'findings', reviewId: 'r1' } }), project({ id: 'b', folderPath: '/work/b' })]
    const next = withProjectSession(projects, 'a', { openFiles: ['src/a.ts'], reviewId: undefined })
    expect(next[0]!.session).toEqual({ url: 'http://a', centerTab: 'findings', openFiles: ['src/a.ts'] })
    expect(next[1]).toBe(projects[1])
    // 中身が空になったら session ごと消す
    expect(withProjectSession([project({ session: { centerTab: 'browser' } })], 'a', { centerTab: undefined })[0]).not.toHaveProperty('session')
  })

  it('読み込み: 壊れた値・危ないパス・空の画面は捨て、ファイルは重ねず上限まで', () => {
    expect(sanitizeProjectSession('x')).toBeUndefined()
    expect(sanitizeProjectSession({ url: 'about:blank', openFiles: [] })).toBeUndefined()
    const s = sanitizeProjectSession({
      url: 'http://localhost:3000', centerTab: 'file:src/a.ts', reviewId: '20261003-101500',
      openFiles: ['src/a.ts', 'src/a.ts', '/etc/passwd', '../secret', 'C:\\x', 42, 'README.md']
    })
    expect(s).toEqual({ url: 'http://localhost:3000', centerTab: 'file:src/a.ts', reviewId: '20261003-101500', openFiles: ['src/a.ts', 'README.md'] })
    const many = sanitizeProjectSession({ openFiles: Array.from({ length: 80 }, (_, i) => `f${i}.ts`) })
    expect(many?.openFiles).toHaveLength(MAX_SESSION_FILES)
  })

  it('設定の読み込みでもプロジェクトの状態を残す（再起動しても戻る）', () => {
    const s = sanitize({ projects: [{ id: 'a', name: 'app', folderPath: '/work/app', urls: [], session: { url: 'http://x', openFiles: ['a.ts', '../b'] } }] })
    expect(s.projects[0]!.session).toEqual({ url: 'http://x', openFiles: ['a.ts'] })
  })

  it('ファイルのタブは根を外して覚え、戻すときに今の根を付け直す', () => {
    expect(encodeCenterTab('file:/work/app/src/a.ts', '/work/app')).toBe('file:src/a.ts')
    expect(encodeCenterTab('file:/work/app/src/a.ts', '/work/app/')).toBe('file:src/a.ts')
    expect(encodeCenterTab('findings', '/work/app')).toBe('findings')
    // 別のプロジェクトのファイルのタブは覚えない
    expect(encodeCenterTab('file:/work/other/a.ts', '/work/app')).toBeUndefined()
    expect(decodeCenterTab('file:src/a.ts', '/moved/app')).toBe('file:/moved/app/src/a.ts')
    expect(decodeCenterTab('browser', '/work/app')).toBe('browser')
    expect(decodeCenterTab('file:../x', '/work/app')).toBeUndefined()
    expect(decodeCenterTab(undefined, '/work/app')).toBeUndefined()
  })
})
