/** site/docs/ の出力先 */
export const DOCS_DIR: string
/** site/docs/ からの相対パス（英語は <page>.html、ほかは <lang>/<page>.html）→ HTML */
export function renderDocs(): Record<string, string>
/** docs の言語（アプリと同じ日本語と英語）とその自称名 */
export const LANGS: string[]
export const LANG_LABELS: Record<string, string>
/** 訳のファイルの置き場所（tools/docs/i18n） */
export const I18N_DIR: string
/** 訳す単位を持つもの: '_site' と各ページ（拡張子なし） */
export const TRANSLATABLE: string[]
/** 英語の訳す単位（id → 原文） */
export function englishUnits(name: string): Map<string, string>
/** 原文のハッシュ（sha256 の先頭10文字） */
export function sourceHash(s: string): string
export function translationPath(lang: string, name: string): string
export function parseTranslation(text: string): Map<string, { hash: string; text: string }>
export function formatTranslation(lang: string, name: string, units: Map<string, { hash: string; text: string }>): string
export function rehashUnits(en: Map<string, string>, have: Map<string, { hash: string; text: string }>, force?: boolean): Map<string, { hash: string; text: string }>
export interface Localized {
  units: Map<string, string>
  status: 'full' | 'partial' | 'none'
  stale: string[]
  missing: string[]
  extra: string[]
}
export function localized(lang: string, name: string): Localized
export function translationStatus(): (Omit<Localized, 'units'> & { lang: string; name: string; exists: boolean })[]
export function unitSize(name: string): number
/** 本文の札（{{keys:…}} など） */
export const TOKEN: RegExp
/** src/shared/agentCatalog.ts の BUILTIN_AGENTS を文字として読んだもの */
export function agentCatalog(): { id: string; label: string; command: string; homepageUrl: string }[]
/** 1つの言語の訳のファイルを検査する（何も書き出さない）。問題の一覧 */
export function checkTranslations(lang: string): string[]
