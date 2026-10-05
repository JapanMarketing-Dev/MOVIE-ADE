/**
 * settings.json に誤りがあるときの「AI への修正依頼」の文（設定のページのボタンでコピーする）。
 * Claude Code・Codex などのコーディングエージェントにそのまま貼れば、誤りの所だけをスキーマに従って直せるようにする。
 *
 * 決まり：
 * - 載せるのはファイルの場所・スキーマの場所・誤りの行・JSON Pointer・理由だけ。設定の値（API キーなど）は載せない
 * - 直すのは並べた誤りだけ。ほかの設定は変えさせない。スキーマに無いプロパティは正しい場所へ移すか消す
 * - 文は UI の言語（t）で作る
 */
import type { MessageParams, TranslationKey } from './i18n'
import type { SettingsFileError, SettingsFileIssue } from './types'

type Translate = (key: TranslationKey, params?: MessageParams) => string

export interface SettingsFixTarget {
  /** settings.json の絶対パス（settingsFile:info の path） */
  path: string
  /** 同じフォルダの settings.schema.json の絶対パス（settingsFile:info の schemaPath） */
  schemaPath: string
  error: SettingsFileError
}

/** 誤りを1行ずつの文にする。スキーマの違反の全件があればそれを、無ければ（JSON の構文の誤りなど）エラーそのものを1件として */
export function settingsFixIssueLines(error: SettingsFileError, t: Translate): string[] {
  if (error.kind === 'schema' && error.issues?.length) return error.issues.map((issue) => issueLine(issue, t))
  if (error.kind === 'parse') {
    const where = error.line ? (error.column ? t('settings.fix.lineColumn', { line: error.line, column: error.column }) : t('settings.fix.line', { line: error.line })) : ''
    return [`${where ? `${where} ` : ''}(${t('settings.fix.syntax')}): ${error.message}`]
  }
  // issues の無いスキーマの違反（トップレベルが object でない、古い形のエラー）。message に場所が入っていることがあるので重ねない
  const message = error.path && !error.message.startsWith(`${error.path}:`) ? `${error.path}: ${error.message}` : error.message
  return [`${error.line ? `${t('settings.fix.line', { line: error.line })} ` : ''}${message}`]
}

function issueLine(issue: SettingsFileIssue, t: Translate): string {
  return `${issue.line ? `${t('settings.fix.line', { line: issue.line })} ` : ''}${issue.path}: ${issue.message}`
}

/** コーディングエージェントに渡す修正依頼の全文 */
export function buildSettingsFixPrompt(target: SettingsFixTarget, t: Translate): string {
  const issues = settingsFixIssueLines(target.error, t).map((line) => `- ${line}`)
  const steps = [
    t('settings.fix.step.readSchema', { schema: target.schemaPath }),
    t('settings.fix.step.onlyErrors'),
    t('settings.fix.step.unknown'),
    t('settings.fix.step.valid', { schema: target.schemaPath }),
    t('settings.fix.step.finish'),
  ].map((s, i) => `${i + 1}. ${s}`)
  return [
    t('settings.fix.intro', { path: target.path, schema: target.schemaPath }),
    '',
    t('settings.fix.errors'),
    ...issues,
    '',
    t('settings.fix.steps'),
    ...steps,
  ].join('\n')
}
