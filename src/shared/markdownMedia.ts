/**
 * Markdown のファイルへ画像・動画を落として埋め込むときの決まり（純粋関数。main と renderer で共有する）。
 *
 *   - 埋め込めるのは下の拡張子だけ（画像: png jpg jpeg gif webp svg avif、動画: mp4 webm mov）
 *   - プロジェクトの中のファイルは、コピーせず Markdown のファイルからの相対パスでつなぐ
 *   - プロジェクトの外のファイルは、Markdown のファイルの隣のフォルダ（assets/ など。pickMediaFolder）へ
 *     重ならない名前でコピーしてからつなぐ（コピーは main の fileOps.ts の importMediaForMarkdown）
 *   - 画像は ![名前](パス)、動画は <video src="パス" controls></video>（GitHub でもそのまま再生できる形）
 */

export type MarkdownMediaKind = 'image' | 'video'

const MEDIA_EXTENSIONS: Record<string, MarkdownMediaKind> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.svg': 'image',
  '.avif': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video'
}

/** 1つのファイルとしてコピーできる大きさの上限 */
export const MAX_MARKDOWN_MEDIA_BYTES: Record<MarkdownMediaKind, number> = {
  image: 50 * 1024 * 1024,
  video: 500 * 1024 * 1024
}

/** 1回のドロップでコピーできる数と合計の上限 */
export const MAX_MARKDOWN_MEDIA_FILES = 50
export const MAX_MARKDOWN_MEDIA_TOTAL_BYTES = 1024 * 1024 * 1024

/** コピー先のフォルダの候補。Markdown の隣に既にあるものを使い、無ければ先頭（assets）を作る */
export const MEDIA_FOLDER_CANDIDATES = ['assets', 'images', 'media', 'img'] as const

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' }
}

/** 埋め込める画像・動画か（拡張子で見る。大文字小文字は問わない）。でなければ null */
export function markdownMediaKind(path: string): MarkdownMediaKind | null {
  return MEDIA_EXTENSIONS[splitExtension(baseName(path)).ext.toLowerCase()] ?? null
}

/**
 * Markdown の隣のフォルダの名前から、コピー先のフォルダを選ぶ。
 * dirs は既にあるフォルダ、taken はフォルダ以外も含めた既にある名前（同じ名前のファイルがあるものは作れない）
 */
export function pickMediaFolder(dirs: Iterable<string>, taken: Iterable<string> = []): string | null {
  const dirSet = new Set(dirs)
  const existing = MEDIA_FOLDER_CANDIDATES.find((name) => dirSet.has(name))
  if (existing) return existing
  const used = new Set([...taken, ...dirSet].map((name) => name.toLowerCase()))
  return MEDIA_FOLDER_CANDIDATES.find((name) => !used.has(name)) ?? null
}

/**
 * コピーするファイルの名前を、Markdown のリンクにそのまま書ける形にする。
 * 空白（macOS のスクリーンショットの名前にある狭い空白も）は - に、リンクや OS で困る記号は除く。拡張子は小文字にする
 */
export function safeMediaFileName(name: string): string {
  const { stem, ext } = splitExtension(baseName(name))
  const clean = stem
    .normalize('NFC')
    // 制御文字と、OS・Markdown のリンクで困る記号
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*#%()[\]{}^`]/g, '')
    .replace(/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return `${clean || 'media'}${ext.toLowerCase()}`
}

/** 重ならない名前（大文字小文字は区別しない）。a.png → a-2.png → a-3.png */
export function uniqueMediaName(name: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((x) => x.toLowerCase()))
  if (!lower.has(name.toLowerCase())) return name
  const { stem, ext } = splitExtension(name)
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
}

/** Markdown のファイル（プロジェクトからの相対パス）から見た、メディア（同じく相対パス）への相対パス（'/' 区切り） */
export function relativeMediaPath(markdownRel: string, mediaRel: string): string {
  const from = markdownRel.split('/').filter(Boolean).slice(0, -1)
  const to = mediaRel.split('/').filter(Boolean)
  let common = 0
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/')
}

/** リンクの行き先に書く形。区切りの / は残し、空白・括弧・% など Markdown や URL で意味を持つ文字だけを符号化する */
export function encodeMarkdownUrl(path: string): string {
  return path.replace(/[%\s()<>[\]#?"'\\^`{}|]/g, (ch) => {
    const code = ch.codePointAt(0)!
    return `%${code.toString(16).toUpperCase().padStart(2, '0')}`
  })
}

function escapeAlt(text: string): string {
  return text.replace(/[\\[\]]/g, (ch) => `\\${ch}`)
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 動画の埋め込みの HTML（プレビューの読み取りと書き出しで同じ形にする） */
export function videoHtml(src: string): string {
  return `<video src="${escapeAttribute(src)}" controls></video>`
}

/** 1つのメディアの書き方。link は Markdown のファイルからの相対パス（符号化の前） */
export function markdownMediaSnippet(kind: MarkdownMediaKind, link: string): string {
  const url = encodeMarkdownUrl(link)
  if (kind === 'video') return videoHtml(url)
  return `![${escapeAlt(mediaAlt(link))}](${url})`
}

/** 画像の代わりの文字（ファイルの名前から拡張子を除いたもの） */
export function mediaAlt(link: string): string {
  return splitExtension(baseName(link)).stem
}

/**
 * ソースのカーソルの位置へ入れる文字列。動画（HTML の塊）も画像も、それぞれ独立した段落になるよう空行で区切る。
 * before / after は同じ行のカーソルの前後の文字
 */
export function sourceInsertion(snippets: readonly string[], before: string, after: string): string {
  if (snippets.length === 0) return ''
  const body = snippets.join('\n\n')
  const lead = before.trim() === '' ? '' : '\n\n'
  const tail = after.trim() === '' ? '' : '\n\n'
  return `${lead}${body}${tail}`
}

/** 動画の HTML から src を取り出す（読み取りの決まり。videoHtml と、手で書いた引用符違いも読む）。無ければ null */
export function parseVideoHtml(html: string): { src: string } | null {
  const match = /^<video\b([^>]*)>\s*<\/video>$/i.exec(html.trim())
  if (!match) return null
  const attrs = match[1]!
  const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
  if (!src) return null
  const value = (src[1] ?? src[2] ?? '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  return value.trim() ? { src: value } : null
}

/** 埋め込み先にできる Markdown のファイルか（エディタが Markdown として開く拡張子） */
export function isMarkdownFilePath(path: string): boolean {
  return /\.(md|markdown|mdx|qmd|rmd)$/i.test(path)
}
