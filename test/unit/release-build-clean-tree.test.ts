/**
 * 配布物は commit した中身だけから作る（0.4.21 は commit していない別の作業の変更が入ったまま作られた）。
 * scripts/build-release.sh が作業ツリーを写す前に、変更・追跡していないファイルがあれば止めることを確かめる
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('配布物のビルドは汚れた作業ツリーで止まる', () => {
  it('写す前に git status で確かめ、明示しない限り止める', () => {
    const src = readFileSync('scripts/build-release.sh', 'utf8')
    const guard = src.indexOf('status --porcelain --untracked-files=normal')
    const copy = src.indexOf('cp -cR "$entry"')
    expect(guard).toBeGreaterThan(0)
    expect(copy).toBeGreaterThan(guard)
    expect(src).toMatch(/FERRET_RELEASE_ALLOW_DIRTY:-\}" != "1" \]\]; then[\s\S]{0,400}exit 1/)
  })
})
