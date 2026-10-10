/**
 * 人の確認リストの質問と答え（src/shared/humanChecklist.ts）。
 * 質問のブロック（番号の選択肢・おすすめ）、「## 回答」への書き込み、答えをまとめて Agent に送る文
 */
import { describe, expect, it } from 'vitest'
import { answerOption, composeAnswersMessage, optionAnswer, parseAnswers, parseHumanChecklist, setAnswers } from '../../src/shared/humanChecklist'

const HUMAN = `# 人が確かめること

| # | 製品 | URL | 見てほしいこと |
|---|---|---|---|
| B1 | 営業企業DB | https://db.example.dev | 検索の速さ |
| A1 | 営業企業DB | - | 本番の DB の削除を承認 |

### Q1 [営業企業DB] 料金プランの形は？
年額は2か月分の割引
1. 月額だけ
2. 月額と年額 (recommended)
3. 年額だけ

### Q2 [ブログ] 公開の曜日は？
おすすめ: 1
1. 火曜
2. 金曜

## 回答

- A1: 承認する
- Q2: 平日ならいつでも https://evil.example
`

describe('質問のブロック', () => {
  it('番号の選択肢とおすすめ、補足を取り出す。回答の欄は項目にしない', () => {
    const items = parseHumanChecklist(HUMAN)
    expect(items.map((i) => i.key)).toEqual(['B1', 'A1', 'Q1', 'Q2'])
    const q1 = items[2]!
    expect(q1.label).toBe('営業企業DB')
    expect(q1.note).toBe('料金プランの形は？ / 年額は2か月分の割引')
    expect(q1.options).toEqual([
      { n: 1, text: '月額だけ', recommended: false },
      { n: 2, text: '月額と年額', recommended: true },
      { n: 3, text: '年額だけ', recommended: false }
    ])
    expect(items[3]!.options!.map((o) => o.recommended)).toEqual([true, false])
  })

  it('答えを項目に付ける', () => {
    const items = parseHumanChecklist(HUMAN)
    expect(items[1]!.answer).toBe('承認する')
    expect(items[3]!.answer).toBe('平日ならいつでも https://evil.example')
    expect(items[0]!.answer).toBeUndefined()
    expect(parseAnswers(HUMAN)).toEqual({ A1: '承認する', Q2: '平日ならいつでも https://evil.example' })
  })

  it('選んだ選択肢は番号と文で残し、番号から選択肢に戻せる', () => {
    const q1 = parseHumanChecklist(HUMAN)[2]!
    const a = optionAnswer(q1.options![1]!)
    expect(a).toBe('2. 月額と年額')
    expect(answerOption(q1, a)).toBe(2)
    expect(answerOption(q1, '9. なし')).toBeNull()
    expect(answerOption(q1, '自由な答え')).toBeNull()
  })
})

describe('「## 回答」への書き込み', () => {
  it('同じ番号の行を置き換え、新しい答えは足し、空なら消す。項目の部分は変えない', () => {
    const next = setAnswers(HUMAN, [{ key: 'A1', answer: '承認しない' }, { key: 'Q1', answer: '2. 月額と年額' }, { key: 'Q2', answer: '' }], 'ja')
    expect(parseAnswers(next)).toEqual({ A1: '承認しない', Q1: '2. 月額と年額' })
    expect(next.slice(0, next.indexOf('## 回答'))).toBe(HUMAN.slice(0, HUMAN.indexOf('## 回答')))
    expect(next.endsWith('\n')).toBe(true)
  })

  it('回答の欄が無ければ最後に足す。改行や制御文字は1行にする', () => {
    const next = setAnswers('| B1 | x | https://a.example | y |\n', [{ key: 'B1', answer: 'OK\n## 見出し\u0007' }], 'en')
    expect(next).toBe('| B1 | x | https://a.example | y |\n\n## Answers\n\n- B1: OK ## 見出し\n')
    expect(parseHumanChecklist(next)).toHaveLength(1)
  })

  it('番号の形でないキーは書かない', () => {
    expect(setAnswers(HUMAN, [{ key: '../x', answer: 'y' }], 'ja')).toBe(HUMAN)
  })

  it('後ろに別の見出しがあってもその前で止まる', () => {
    const md = '## 回答\n\n- A1: x\n\n## メモ\n\n- A2: 残す\n'
    const next = setAnswers(md, [{ key: 'A2', answer: 'y' }], 'ja')
    expect(next).toBe('## 回答\n\n- A1: x\n- A2: y\n\n## メモ\n\n- A2: 残す\n')
  })
})

describe('答えをまとめて送る文', () => {
  it('答えた項目だけを、並行して進める指示と許可した操作と一緒に送る', () => {
    const msg = composeAnswersMessage(parseHumanChecklist(HUMAN), 'ja', 'dev 環境へのデプロイ')
    expect(msg).toContain('A1 [営業企業DB] 本番の DB の削除を承認\n  → 承認する')
    expect(msg).toContain('並行')
    expect(msg).toContain('dev 環境へのデプロイ')
    expect(msg).not.toContain('Q1 ')
  })

  it('長くても送れる長さに収め、残りは human.md を読むよう書く', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ key: `D${i + 1}`, label: 'p', url: '', note: 'x'.repeat(200), answer: 'y'.repeat(200) }))
    const msg = composeAnswersMessage(items, 'en')
    expect(msg.length).toBeLessThanOrEqual(8000)
    expect(msg).toMatch(/\d+ more: read "## Answers"/)
  })
})

describe('human.md への書き込み（main）', () => {
  it('答えを書いて確認リストを返す。human.md が無ければ作らず、リンクの先には書かない', async () => {
    const { mkdtemp, readFile, rm, symlink, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { writeAnswers } = await import('../../src/main/orchestraOverview')
    const dir = await mkdtemp(join(tmpdir(), 'human-answers-'))
    try {
      expect(await writeAnswers(dir, [{ key: 'Q1', answer: 'x' }], 'ja')).toEqual([])
      await writeFile(join(dir, 'human.md'), HUMAN)
      const items = await writeAnswers(dir, [{ key: 'Q1', answer: '2. 月額と年額' }], 'ja')
      expect(items.find((i) => i.key === 'Q1')!.answer).toBe('2. 月額と年額')
      expect(await readFile(join(dir, 'human.md'), 'utf8')).toContain('- Q1: 2. 月額と年額')
      const other = await mkdtemp(join(tmpdir(), 'human-answers-target-'))
      await writeFile(join(other, 'human.md'), HUMAN)
      const linked = await mkdtemp(join(tmpdir(), 'human-answers-link-'))
      await symlink(join(other, 'human.md'), join(linked, 'human.md'))
      await expect(writeAnswers(linked, [{ key: 'Q1', answer: 'y' }], 'ja')).rejects.toThrow()
      expect(await readFile(join(other, 'human.md'), 'utf8')).toBe(HUMAN)
      await rm(other, { recursive: true, force: true })
      await rm(linked, { recursive: true, force: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('人の確認なしで進めてよい操作', () => {
  it('全体の CLAUDE.md と subagent に入り、保存の形でも残る。並行して進める決まりも入る', async () => {
    const { renderOrchestratorGuide, renderSubagent, sanitizeOrchestraRules } = await import('../../src/shared/orchestrator')
    const rules = sanitizeOrchestraRules({ allowed: 'dev 環境へのデプロイ' })
    expect(rules).toEqual({ allowed: 'dev 環境へのデプロイ' })
    const guide = renderOrchestratorGuide([], rules)
    expect(guide).toContain('Operations allowed without asking a person')
    expect(guide).toContain('dev 環境へのデプロイ')
    expect(guide).toMatch(/Never run products one after another/)
    const sub = renderSubagent({ name: 'p', dir: 'p', path: '/x/p', agent: 'p-lead' } as Parameters<typeof renderSubagent>[0], rules)
    expect(sub).toContain('dev 環境へのデプロイ')
    expect(sub).toContain('own tab or window')
  })
})
