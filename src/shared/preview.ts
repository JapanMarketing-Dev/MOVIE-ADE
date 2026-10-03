import { t } from './i18n'
/**
 * markdown / Mermaid のプレビュー（内蔵ブラウザで開き、そのまま録画でレビューできるページ）の URL の規則。
 *
 *   ade-preview://project/<プロジェクトからの相対パス>   … プレビューのページ（.md / .mmd / .mermaid）
 *   ade-preview://assets/<名前>                           … ページが読むスタイル・スクリプト（同梱）
 *
 * standard なスキームは先頭の区切りをホスト名として小文字にしてしまうため、
 * 相対パスはホスト（project）の後ろのパスに入れる。
 * 指摘の URL にはこの形がそのまま残るので、feedback.md ではファイルの相対パスに直して見せる。
 */

export const PREVIEW_SCHEME = 'ade-preview'
export const PREVIEW_PROJECT_HOST = 'project'
export const PREVIEW_ASSET_HOST = 'assets'

export type PreviewKind = 'markdown' | 'mermaid'

/** プレビューできるファイルか。できなければ null */
export function previewKind(path: string): PreviewKind | null {
  const lower = path.toLowerCase()
  if (/\.(md|markdown|mdx)$/.test(lower)) return 'markdown'
  if (/\.(mmd|mermaid)$/.test(lower)) return 'mermaid'
  return null
}

/** 相対パス → プレビューの URL（区切りごとに符号化する） */
export function previewUrl(path: string): string {
  return `${PREVIEW_SCHEME}://${PREVIEW_PROJECT_HOST}/${path.split('/').map(encodeURIComponent).join('/')}`
}

/** プレビューの URL → 相対パス。プレビューの URL でなければ null（クエリ・ハッシュは見ない） */
export function previewPathFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${PREVIEW_SCHEME}:` || parsed.hostname !== PREVIEW_PROJECT_HOST) return null
  try {
    const path = parsed.pathname.replace(/^\/+/, '').split('/').map(decodeURIComponent).join('/')
    return path || null
  } catch {
    return null
  }
}

/** feedback.md の「対象」「URL」欄に出す形。プレビューならファイルの相対パスにする */
export function describeTargetUrl(url: string): string | null {
  const path = previewPathFromUrl(url)
  return path ? t('feedbackMd.previewTarget', { path, url }) : null
}

// ─── Mermaid のブロックの抽出 ─────────────────────────────

/** フェンスの言語名が Mermaid か（```mermaid / ```mmd、後ろの属性は無視） */
export function isMermaidFence(lang: string | undefined): boolean {
  const name = (lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return name === 'mermaid' || name === 'mmd'
}
