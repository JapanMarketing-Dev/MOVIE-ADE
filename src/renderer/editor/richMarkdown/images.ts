import { projectMediaUrl } from '@shared/fileViewer'

/**
 * プレビューで編集するときの画像の行き先（純粋関数）。プレビューのページ（src/main/preview/render.ts）と同じ決まり:
 *   - プロジェクトの中の相対パス … ade-media://project/ で読む（main がプロジェクトの外・リンクを断る）
 *   - data: … そのまま
 *   - 外の画像（http(s)・// で始まる・ほかのスキーム）… 読まない。行き先のホストだけを見せる（security-3 [5]）
 * 画面の CSP（src/renderer/index.html）も https の画像を許していないので、ここで間違えても読みには行かない。
 */
export type RichImageSource =
  | { kind: 'local'; url: string }
  | { kind: 'data'; url: string }
  | { kind: 'remote'; host: string }
  | { kind: 'invalid' }

/** 外の画像か（http(s)・// で始まる・data: 以外のスキーム） */
export function isRemoteImage(src: string): boolean {
  const value = src.trim()
  if (value.startsWith('//')) return true
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase()
  return scheme !== undefined && scheme !== 'data'
}

export function remoteImageHost(src: string): string {
  const value = src.trim()
  try {
    return new URL(value.startsWith('//') ? `https:${value}` : value).host || value
  } catch {
    return value
  }
}

/** Markdown のファイル（プロジェクトからの相対パス）から見た画像の src を、表示に使う URL にする */
export function resolveRichImage(src: string, markdownPath: string): RichImageSource {
  const value = src.trim()
  if (!value) return { kind: 'invalid' }
  if (/^data:image\//i.test(value)) return { kind: 'data', url: value }
  if (isRemoteImage(value)) return { kind: 'remote', host: remoteImageHost(value) }
  let path = value.replace(/[?#].*$/, '')
  try {
    path = decodeURI(path)
  } catch {
    return { kind: 'invalid' }
  }
  // / で始まるものはプロジェクトの根から（プレビューのページと同じ）
  const base = path.startsWith('/') ? [] : markdownPath.split('/').slice(0, -1)
  const parts: string[] = [...base]
  for (const segment of path.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      // プロジェクトの外へ出るパスは読まない
      if (parts.length === 0) return { kind: 'invalid' }
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  if (parts.length === 0) return { kind: 'invalid' }
  return { kind: 'local', url: projectMediaUrl(parts.join('/')) }
}
