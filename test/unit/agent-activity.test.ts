import { describe, expect, it } from 'vitest'
import { workingProjectIds } from '../../src/renderer/terminal/agentActivity'

describe('サイドバーの「実行中」の印に使うプロジェクト', () => {
  it('working のペインを持つプロジェクトだけを、重複なしで並びを固定して返す', () => {
    expect(workingProjectIds([
      { projectId: 'p2', state: 'working' },
      { projectId: 'p1', state: 'idle' },
      { projectId: 'p1', state: 'working' },
      { projectId: 'p2', state: 'working' },
      { projectId: 'p3', state: 'done' }
    ])).toEqual(['p1', 'p2'])
  })

  it('待機・終わった・確認待ち・不明・未登録のフォルダは印を出さない', () => {
    expect(workingProjectIds([
      { projectId: 'p1', state: 'blocked' },
      { projectId: 'p1', state: 'unknown' },
      { projectId: null, state: 'working' }
    ])).toEqual([])
  })
})
