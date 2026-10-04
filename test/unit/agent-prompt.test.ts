import { describe, expect, it, vi } from 'vitest'
import { defaultAgentPrompt, renderAgentPrompt } from '@shared/agentPrompt'
import { setLocale } from '@shared/i18n'
import { buildPrompt, fitsSingleWrite, sanitizePastePayload } from '../../src/main/agent/sanitize'
import { renderSendCommand } from '../../src/main/pipeline/feedback'

// settings.ts は保存先を決めるためだけに electron の app を読む。単体テストでは呼ばれない
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit' } }))
const { sanitize } = await import('../../src/main/settings')

const relativeDir = '.ade-movie/reviews/20261003-101500'
const feedbackMd = '/Users/me/my app/.ade-movie/reviews/20261003-101500/feedback.md'
const target = { relativeDir, feedbackMd }
const progressJson = '/Users/me/my app/.ade-movie/reviews/20261003-101500/progress.json'

describe('Agentへ渡す指示のテンプレート', () => {
  it('{{path}} は絶対パス、{{relpath}} は相対パスに置き換える（何度出てきても）', () => {
    expect(renderAgentPrompt({ ...target, relativeDir: `${relativeDir}/` }, '{{path}} を直して。{{relpath}} / {{path}}')).toBe(
      `${feedbackMd} を直して。${relativeDir}/feedback.md / ${feedbackMd}`
    )
  })

  it('空・空白だけ・未設定なら既定文（絶対パスを引用符で囲む）を使う', () => {
    const expected = defaultAgentPrompt().replace('{{path}}', feedbackMd).replace('{{progress}}', progressJson)
    expect(expected.startsWith(`Read "${feedbackMd}"`)).toBe(true)
    expect(defaultAgentPrompt()).toContain('{{path}}')
    expect(renderAgentPrompt(target)).toBe(expected)
    expect(renderAgentPrompt(target, '')).toBe(expected)
    expect(renderAgentPrompt(target, '   \n ')).toBe(expected)
    expect(renderAgentPrompt(target, null)).toBe(expected)
  })

  it('既定文は画面の言語に合わせる。利用者が書き換えた文は言語に依らずそのまま使う', () => {
    setLocale('ja')
    expect(renderAgentPrompt(target)).toBe(`"${feedbackMd}" と、同じフォルダにある各指摘の画像を読み、送信対象の指摘をすべて実装してください。受け入れ条件は、すべての指摘が実装され、指摘ごとに完了したことを確かめたことです。確かめるときは、変更した画面や動作を実際に確認してください。テストやビルドが通るだけでは完了としません。最後に、指摘ごとに「完了／未完了（理由）」と確かめた方法を一覧で報告してください。未完了の指摘が残っている間は、完了と報告しないでください。 作業しながら、feedback.md の「進み具合」の節に従って "${progressJson}" に指摘ごとの進み具合を書いてください。指摘ごとに「直す → feedback.md の「AFTER のスクリーンショット」の節のとおり AFTER を撮る → human_review にする」を1つの単位とし、使えるならサブエージェントで並列に進めてください。done にするのはレビューした人だけです。レビューした人に質問して止まらないでください。前提が合わない指摘（録画が古いなど）も、意図に最も沿う形で実装して AFTER を撮り、human_review にして、何を仮定したかを note に1行で書いてください。`)
    expect(renderAgentPrompt(target, 'Fix {{path}}')).toBe(`Fix ${feedbackMd}`)
    setLocale('en')
    expect(renderAgentPrompt(target, '{{path}} を直して')).toBe(`${feedbackMd} を直して`)
    expect(renderAgentPrompt(target, null, 'ja')).toContain('すべて実装してください')
  })

  it('既定文は受け入れ条件つきの依頼（全件の実装・指摘ごとの確認・画面での確認・完了／未完了の一覧・未完了なら完了と言わない）', () => {
    const en = defaultAgentPrompt('en')
    expect(en).toContain('implement every finding')
    expect(en).toContain('Acceptance criteria')
    expect(en).toContain('passing tests or a successful build alone does not count as done')
    expect(en).toContain('"Done" or "Not done (reason)"')
    expect(en).toContain('Do not report the work as complete while any finding is not done')
    const ja = defaultAgentPrompt('ja')
    for (const phrase of ['すべて実装', '受け入れ条件', 'テストやビルドが通るだけでは完了としません', '「完了／未完了（理由）」', '完了と報告しないでください']) {
      expect(ja).toContain(phrase)
    }
  })

  it('既定文は1段落で、1回の書き込みに収まる（改行を含めない）', () => {
    for (const locale of ['en', 'ja'] as const) {
      const text = renderAgentPrompt(target, null, locale)
      expect(text).not.toMatch(/[\r\n]/)
      expect(fitsSingleWrite(sanitizePastePayload(text))).toBe(true)
      // ターミナルに貼って読める長さ（目安 1KB 程度）
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(1500)
    }
  })

  it('絶対パスが分からない呼び出し元では {{path}} も相対パスで代える', () => {
    expect(renderAgentPrompt({ relativeDir }, '{{path}}')).toBe(`${relativeDir}/feedback.md`)
  })

  it('buildPrompt / renderSendCommand も同じ組み立てを通る', () => {
    expect(buildPrompt(relativeDir, 'A {{path}}', feedbackMd)).toBe(`A ${feedbackMd}`)
    expect(renderSendCommand(relativeDir, 'A {{relpath}}', feedbackMd)).toBe(`A ${relativeDir}/feedback.md`)
    expect(buildPrompt(relativeDir)).toBe(renderSendCommand(relativeDir))
  })

  it('設定の読み込み: 空は未設定に戻し、前後の空白は落とす', () => {
    expect(sanitize({ agentPrompt: '   ' }).agentPrompt).toBeUndefined()
    expect(sanitize({ agentPrompt: 42 }).agentPrompt).toBeUndefined()
    expect(sanitize({ agentPrompt: '  {{path}} を見て  ' }).agentPrompt).toBe('{{path}} を見て')
  })
})
