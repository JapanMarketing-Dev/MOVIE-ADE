/**
 * settings.json に誤りがあるときの「AI への修正依頼」の文のテスト。
 */
import { describe, expect, it } from 'vitest'
import { SUPPORTED_LOCALES, translate, type SupportedLocale } from '@shared/i18n'
import { buildSettingsFixPrompt, settingsFixIssueLines } from '@shared/settingsFixPrompt'
import type { SettingsFileError } from '@shared/types'

const tOf = (locale: SupportedLocale) => (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(locale, key, params)
const PATH = '/Users/me/Library/Application Support/Ferret/settings.json'
const SCHEMA = '/Users/me/Library/Application Support/Ferret/settings.schema.json'
const SCHEMA_ERROR: SettingsFileError = {
  kind: 'schema',
  message: '/layout/footer/items/organizer: unknown property (+1 more)',
  path: '/layout/footer/items/organizer',
  line: 358,
  issues: [
    { path: '/layout/footer/items/organizer', message: 'unknown property', line: 358 },
    { path: '/capture/keepDays', message: 'must be integer' },
  ],
}

describe('buildSettingsFixPrompt', () => {
  it('ファイルとスキーマの絶対パス・各誤りの行と場所と理由・直し方の決まりを載せる', () => {
    const prompt = buildSettingsFixPrompt({ path: PATH, schemaPath: SCHEMA, error: SCHEMA_ERROR }, tOf('ja'))
    expect(prompt).toContain(PATH)
    expect(prompt).toContain(SCHEMA)
    expect(prompt).toContain('- 358 行目 /layout/footer/items/organizer: unknown property')
    expect(prompt).toContain('- /capture/keepDays: must be integer')
    expect(prompt).toContain('直すのは上に挙げた誤りだけ')
    expect(prompt).toContain('unknown property')
    expect(prompt).toContain('正しい JSON')
    expect(prompt).not.toContain('{{')
  })

  it('JSON の構文の誤りは行と列を付けて1件にする', () => {
    const lines = settingsFixIssueLines({ kind: 'parse', message: "Expected ',' or '}' after property value in JSON at position 120", line: 7, column: 3 }, tOf('en'))
    expect(lines).toEqual(["line 7, column 3 (JSON syntax): Expected ',' or '}' after property value in JSON at position 120"])
  })

  it('issues の無いスキーマの違反は message をそのまま使い、場所を重ねない', () => {
    expect(settingsFixIssueLines({ kind: 'schema', message: '/x: unknown property', path: '/x', line: 2 }, tOf('en'))).toEqual(['line 2 /x: unknown property'])
    expect(settingsFixIssueLines({ kind: 'schema', message: 'The top level must be a JSON object.', path: '/', line: 1 }, tOf('en'))).toEqual(['line 1 /: The top level must be a JSON object.'])
  })

  it('全言語で決まりの文が訳されていて、パスと誤りが入る', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const prompt = buildSettingsFixPrompt({ path: PATH, schemaPath: SCHEMA, error: SCHEMA_ERROR }, tOf(locale))
      expect(prompt, locale).toContain(PATH)
      expect(prompt, locale).toContain(SCHEMA)
      expect(prompt, locale).toContain('/layout/footer/items/organizer: unknown property')
      expect(prompt, locale).toContain('358')
      expect(prompt, locale).not.toMatch(/\{\{|settings\.fix\./)
      expect(prompt.split('\n').filter((l) => /^\d\. /.test(l)), locale).toHaveLength(5)
    }
  })
})
