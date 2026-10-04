import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 画面の部品で、早い return（`if (...) return null` など）より後ろでフックを呼ばない。
 * 描画のたびにフックの数が変わると React が #310 で落ち、その部品（内蔵ブラウザの欄など）が丸ごと出なくなる。
 * 0.4.6 の公開前の E2E で、UrlPresets の useState が `if (!project) return null` の後ろにあって全件落ちた。
 * eslint の react-hooks を入れていないので、部品の本体（2字下げ）の形だけを機械的に見る。
 */
function hooksAfterEarlyReturn(file: string, text: string): string[] {
  const out: string[] = []
  const lines = text.split('\n')
  let inComponent = false
  let returnedAt = -1
  lines.forEach((line, i) => {
    if (/^(export )?(default )?function ([A-Z]\w*|use[A-Z]\w*)\(/.test(line)) { inComponent = true; returnedAt = -1; return }
    if (/^}\s*$/.test(line)) { inComponent = false; return }
    if (!inComponent) return
    if (/^ {2}if \(.*\)\s*return\b/.test(line)) { returnedAt = i; return }
    if (returnedAt >= 0 && /^ {2}(const|let) .*=\s*use[A-Z]\w*[<(]|^ {2}use[A-Z]\w*[<(]/.test(line)) out.push(`${file}:${i + 1}（早い return は ${returnedAt + 1} 行目）`)
  })
  return out
}

describe('React のフックの順番', () => {
  it('早い return の後ろでフックを呼ぶ部品が無い', () => {
    // git の無い場所（Windows・Linux の関門は commit の中身だけを写して流す）でも動くよう、フォルダを直接たどる
    const files = (readdirSync('src/renderer', { recursive: true, encoding: 'utf8' }) as string[])
      .filter((f) => /\.tsx?$/.test(f)).map((f) => join('src/renderer', f))
    expect(files.length).toBeGreaterThan(50)
    expect(files.flatMap((f) => hooksAfterEarlyReturn(f, readFileSync(f, 'utf8')))).toEqual([])
  })

  it('検査そのもの: 早い return の後ろの useState を見つけ、前なら通す', () => {
    const bad = 'export function A({ p }: { p: string | null }) {\n  const [a] = useState(0)\n  if (!p) return null\n  const [b, setB] = useState<number | null>(null)\n  return null\n}\n'
    const good = 'export function A({ p }: { p: string | null }) {\n  const [a] = useState(0)\n  const [b] = useState<number | null>(null)\n  if (!p) return null\n  return null\n}\n'
    expect(hooksAfterEarlyReturn('a.tsx', bad)).toEqual(['a.tsx:4（早い return は 3 行目）'])
    expect(hooksAfterEarlyReturn('a.tsx', good)).toEqual([])
  })
})
