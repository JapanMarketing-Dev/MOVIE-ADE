/**
 * Office の文書（Word・Excel・PowerPoint）のプレビュー。どの形式かの判定と、HTML への変換の入口。
 * 変換は renderer で行い、結果は sandbox の iframe（スクリプト無し・外へは読みに行かない）に出す。
 * マクロ付き（.docm など）も中のマクロは動かさず、内容だけを読む。
 */
import { openZip, OfficeFormatError } from './zip'
import { renderDocx } from './docx'
import { renderXlsx, type XlsxSheet } from './xlsx'
import { renderPptx } from './pptx'

export { OfficeFormatError }
export { MAX_OFFICE_BYTES, isLegacyOffice, officeKindOf, type OfficeKind } from './kinds'
import type { OfficeKind } from './kinds'

export interface OfficeLabels {
  missingImage: string
  chart: string
  slide: (n: number, total: number) => string
  sheetTruncated: string
}

export type OfficePreview =
  | { kind: 'document'; html: string }
  | { kind: 'slides'; html: string; slides: number }
  | { kind: 'sheets'; sheets: XlsxSheet[] }

export async function renderOffice(kind: OfficeKind, bytes: Uint8Array, title: string, labels: OfficeLabels): Promise<OfficePreview> {
  // 暗号化した文書（パスワード付き）は ZIP ではなく OLE の入れ物になる
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) throw new OfficeFormatError('encrypted or legacy office file')
  const zip = openZip(bytes)
  if (kind === 'docx') return { kind: 'document', html: await renderDocx(zip, title, labels) }
  if (kind === 'pptx') {
    const { html, slides } = await renderPptx(zip, title, { slide: labels.slide, chart: labels.chart })
    return { kind: 'slides', html, slides }
  }
  return { kind: 'sheets', sheets: await renderXlsx(zip, { truncated: labels.sheetTruncated }) }
}
