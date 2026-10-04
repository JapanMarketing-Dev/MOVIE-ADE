import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * mac では通るのに Windows・Linux の CI でだけ落ちる書き方を、mac の単体テストの段階で止める（RULES.md）。
 * 公開の前の関門（scripts/cross-os-unit.sh）でも見つかるが、書いた時点で気づけるものだけをここに置く。誤検出の多い検査は入れない。
 */

const dir = resolve(__dirname)
const files = readdirSync(dir).filter((f) => /\.test\.tsx?$/.test(f) && f !== 'cross-os-test-hygiene.test.ts')

describe('OS に依存するテストの書き方', () => {
  it('ファイルの実行・読み書きの権限（mode のビット）を確かめるテストは、Windows を飛ばしている', () => {
    // Windows の stat は実行のビットを持たず、0o600 なども 0o666 で返す。直前の数行に OS の分岐が無ければ指摘する
    const bad: string[] = []
    for (const f of files) {
      const lines = readFileSync(join(dir, f), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/expect\([^\n]*\.mode\s*&\s*0o[0-7]+/.test(line)) return
        const around = lines.slice(Math.max(0, i - 12), i + 1).join('\n')
        if (!/win32|posix|skipIf|runIf|process\.platform/.test(around)) bad.push(`${f}:${i + 1}`)
      })
    }
    expect(bad).toEqual([])
  })
})
