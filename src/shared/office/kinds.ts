/** Office の文書の種類の判定（main も読むので、変換の部品は含めない） */

export type OfficeKind = 'docx' | 'xlsx' | 'pptx'

const OFFICE_EXTENSIONS: Record<string, OfficeKind> = {
  '.docx': 'docx', '.docm': 'docx', '.dotx': 'docx', '.dotm': 'docx',
  '.xlsx': 'xlsx', '.xlsm': 'xlsx', '.xltx': 'xlsx', '.xltm': 'xlsx',
  '.pptx': 'pptx', '.pptm': 'pptx', '.ppsx': 'pptx', '.ppsm': 'pptx', '.potx': 'pptx', '.potm': 'pptx'
}

/** 古い形式（バイナリの Office 97-2003）。読めないので、外のアプリで開くよう案内する */
const LEGACY_OFFICE = new Set(['.doc', '.dot', '.xls', '.xlt', '.ppt', '.pps', '.pot'])

/** プレビューする大きさの上限（全体を読み込んで展開するので絞る） */
export const MAX_OFFICE_BYTES = 50 * 1024 * 1024

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export function officeKindOf(path: string): OfficeKind | null {
  return OFFICE_EXTENSIONS[extensionOf(path)] ?? null
}

export function isLegacyOffice(path: string): boolean {
  return LEGACY_OFFICE.has(extensionOf(path))
}
