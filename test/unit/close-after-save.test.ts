import { describe, expect, it } from 'vitest'
import { canCloseAfterSave } from '../../src/renderer/editor/closeAfterSave'

describe('「保存して閉じる」の書き込み中に打った分を捨てない（Orca #20482）', () => {
  it('書いた内容のままなら閉じる', () => {
    expect(canCloseAfterSave('a', 'a')).toBe(true)
    expect(canCloseAfterSave(undefined, undefined)).toBe(true)
  })

  it('書き込み中に打った分があれば閉じない', () => {
    expect(canCloseAfterSave('a', 'ab')).toBe(false)
    expect(canCloseAfterSave(undefined, 'x')).toBe(false)
  })
})
