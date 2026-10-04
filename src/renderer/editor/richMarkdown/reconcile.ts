import type { JSONContent } from '@tiptap/core'
import type { MarkdownCodec } from './codec'

/**
 * プレビューで編集した文書を、元の Markdown の書き方を崩さずにファイルの文字列へ戻す。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/editor/rich-markdown-source-reconcile.ts・
 *   rich-markdown-block-source.ts・markdown-frontmatter.ts（MIT）の考え方
 *   - 変えていない部分は元の文字列のまま残す（見出しの記法・リストの記号・空行・表の整列）
 *   - 変えた部分だけを書き直し、結果を読み直して編集中の文書と同じになると確かめられたときだけ使う。
 *     確かめられなければ、TipTap の書き方（正規形）に戻す（内容を壊したり、別の場所へ動かしたりしない）
 *   - 改行（CRLF）と frontmatter はそのまま運ぶ
 * Orca は diff-match-patch で文字単位に当てる。ここは依存を足さず、最上位の塊（marked の字句）ごとに対応を取り、
 * 変わった塊の中だけ「変わった範囲」を元の文字列の中で探して差し替える。
 */

type Eol = '\n' | '\r\n'

interface SourceUnit {
  /** 塊の元の文字列（marked の raw） */
  raw: string
  /** 次の塊までの空行（space の字句） */
  gap: string
  /** この塊だけを読んだときの最上位の塊（参照リンクの定義を添えて読む） */
  nodes: JSONContent[]
  /** 参照リンクの定義（[a]: url）。文書には出ない */
  definition: boolean
}

export interface SourceModel {
  eol: Eol
  /** 先頭の frontmatter（--- か +++ で囲んだ部分。区切りと末尾の改行を含む）。無ければ '' */
  frontmatter: string
  /** frontmatter の後ろ（LF） */
  body: string
  /** 最初の塊の前の空行 */
  leading: string
  /** 塊ごとの対応。取れなければ null（そのときは書き直した全体を使う） */
  units: SourceUnit[] | null
  /** 本文を読んだ最上位の塊（エディタに入れる内容） */
  nodes: JSONContent[]
}

const FRONTMATTER_RE = /^(---|\+\+\+)\n(?:[\s\S]*?\n)?\1(?:\n|$)/

/** 1回の編集で読み直す大きさの上限。超えたら塊の対応は取らず、書き直した全体を使う */
export const RECONCILE_SIZE_CAP = 400_000

function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length - crlf
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n'
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function restoreEol(text: string, eol: Eol): string {
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

/** 先頭の frontmatter と本文に分ける（LF の文字列で） */
export function splitFrontmatter(lf: string): { frontmatter: string; body: string } {
  const match = FRONTMATTER_RE.exec(lf)
  if (!match) return { frontmatter: '', body: lf }
  return { frontmatter: match[0], body: lf.slice(match[0].length) }
}

function key(node: JSONContent): string {
  return JSON.stringify(node)
}

function sameNodes(a: readonly JSONContent[], b: readonly JSONContent[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (key(a[i]!) !== key(b[i]!)) return false
  return true
}

/** 同じ塊を何度も読まない（打鍵のたびに作り直すので） */
const unitCache = new WeakMap<MarkdownCodec, Map<string, JSONContent[]>>()

function parseUnit(codec: MarkdownCodec, raw: string, definitions: string): JSONContent[] {
  let cache = unitCache.get(codec)
  if (!cache) unitCache.set(codec, (cache = new Map()))
  // 末尾の改行は落として読む（@tiptap/markdown は塊の後ろの空行を空の段落にすることがある）
  const body = raw.replace(/\n+$/, '')
  const text = definitions ? `${body}\n\n${definitions}` : body
  const hit = cache.get(text)
  if (hit) return hit
  const nodes = codec.parse(text)
  if (cache.size > 2000) cache.clear()
  cache.set(text, nodes)
  return nodes
}

/** ファイルの文字列を、塊ごとの対応つきで読む */
export function buildSourceModel(source: string, codec: MarkdownCodec): SourceModel {
  const eol = detectEol(source)
  const { frontmatter, body } = splitFrontmatter(toLf(source))
  const nodes = codec.parse(body)
  const model: SourceModel = { eol, frontmatter, body, leading: '', units: null, nodes }
  if (body.length > RECONCILE_SIZE_CAP) return model

  const tokens = codec.lex(body)
  // 字句をつなげて元に戻らない（定義などが塊をまたぐ）ときは、対応を推測しない
  if (tokens.map((token) => token.raw).join('') !== body) return model
  const definitions = tokens.filter((token) => token.type === 'def').map((token) => token.raw.replace(/\n*$/, '\n')).join('')

  const units: SourceUnit[] = []
  let leading = ''
  for (const token of tokens) {
    if (token.type === 'space') {
      const last = units.at(-1)
      if (last) last.gap += token.raw
      else leading += token.raw
      continue
    }
    const definition = token.type === 'def'
    units.push({ raw: token.raw, gap: '', definition, nodes: definition ? [] : parseUnit(codec, token.raw, definitions) })
  }
  // 塊ごとに読んだ結果が、全体を読んだ結果と同じときだけ対応を使う
  if (!sameNodes(units.flatMap((unit) => unit.nodes), nodes)) return model
  model.leading = leading
  model.units = units
  return model
}

/** 2つの列の最長共通部分列（a の添字 → b の添字） */
function lcs(a: readonly string[], b: readonly string[]): Map<number, number> {
  // 前後の一致を先に外す（ふつうの編集はほとんどが一致する）
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1 }
  const pairs = new Map<number, number>()
  for (let i = 0; i < start; i += 1) pairs.set(i, i)
  for (let i = 0; i < a.length - endA; i += 1) pairs.set(endA + i, endB + i)
  const n = endA - start
  const m = endB - start
  if (n > 0 && m > 0 && n * m <= 4_000_000) {
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i]![j] = a[start + i] === b[start + j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) { pairs.set(start + i, start + j); i += 1; j += 1 }
      else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1
      else j += 1
    }
  }
  return pairs
}

function countOf(haystack: string, needle: string): number {
  let count = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    count += 1
    if (count > 1) break
  }
  return count
}

/**
 * 正規形どうしの差（before → after）を、元の文字列 raw の中の同じ箇所に当てる。
 * 変わった範囲（前後の一致を除いた部分）を、前後の文脈を少しずつ足しながら raw の中で1か所だけ見つかる形にして差し替える。
 * 見つからなければ null。当てた結果が正しいかは呼ぶ側が読み直して確かめる。
 */
export function patchSource(raw: string, before: string, after: string): string | null {
  if (before === after) return raw
  let prefix = 0
  const limit = Math.min(before.length, after.length)
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1
  let suffix = 0
  while (suffix < limit - prefix && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix += 1
  const removed = before.slice(prefix, before.length - suffix)
  const added = after.slice(prefix, after.length - suffix)
  const left = before.slice(0, prefix)
  const right = before.slice(before.length - suffix)
  for (const size of [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32]) {
    for (const [l, r] of [[size, 0], [0, size], [size, size]] as const) {
      const leftContext = left.slice(left.length - Math.min(l, left.length))
      const rightContext = right.slice(0, r)
      const needle = leftContext + removed + rightContext
      if (!needle || countOf(raw, needle) !== 1) continue
      const at = raw.indexOf(needle)
      return raw.slice(0, at) + leftContext + added + rightContext + raw.slice(at + needle.length)
    }
  }
  return null
}

interface Piece {
  text: string
  /** 元の塊の添字（元の文字列を使ったとき）。次も元の続きの塊なら、元の空行でつなぐ */
  index: number | null
  /** 元の文字列を使ったときの最初の塊の添字（いくつかの塊をまとめて書き直したとき index と違う） */
  first: number | null
}

function trailingNewlines(text: string): string {
  return /\n*$/.exec(text)?.[0] ?? ''
}

function canonicalBody(codec: MarkdownCodec, nodes: JSONContent[], original: string): string {
  const text = codec.serialize(nodes).replace(/\n+$/, '')
  return text ? text + (trailingNewlines(original) || '') : ''
}

/**
 * 編集後の文書（最上位の塊）を、元のファイルの書き方に合わせた文字列にする。
 * frontmatter は editedFrontmatter（区切りを含む全体）があればそれ、無ければ元のまま。
 */
export function reconcileMarkdown(model: SourceModel, edited: JSONContent[], codec: MarkdownCodec, editedFrontmatter?: string): string {
  const frontmatter = editedFrontmatter ?? model.frontmatter
  const finish = (body: string) => restoreEol(frontmatter + body, model.eol)
  if (sameNodes(edited, model.nodes)) return finish(model.body)
  const canonical = () => finish(canonicalBody(codec, edited, model.body))
  const units = model.units
  if (!units) return canonical()

  // 塊の対応: 元の塊の中の最上位の塊を一列に並べ、編集後の列と突き合わせる
  const flat: { unit: number; key: string }[] = []
  units.forEach((unit, index) => unit.nodes.forEach((node) => flat.push({ unit: index, key: key(node) })))
  const editedKeys = edited.map(key)
  const pairs = lcs(flat.map((entry) => entry.key), editedKeys)
  // 塊の中身がすべて、続いたまま残っていれば「変えていない塊」
  const keptAt = new Map<number, number>()
  let flatIndex = 0
  units.forEach((unit, index) => {
    const first = pairs.get(flatIndex)
    let kept = unit.nodes.length > 0 && first !== undefined
    for (let k = 1; kept && k < unit.nodes.length; k += 1) kept = pairs.get(flatIndex + k) === first! + k
    if (kept) keptAt.set(index, first!)
    flatIndex += unit.nodes.length
  })

  const definitions = units.filter((unit) => unit.definition).map((unit) => unit.raw.replace(/\n*$/, '\n')).join('')
  const pieces: Piece[] = []
  let deleted: number[] = []
  let anchors: number[] = []
  let next = 0
  const flush = (end: number) => {
    const inserted = edited.slice(next, end)
    // 続けて並んだ塊をいくつか直した（数は同じ）ときは、塊ごとに当てる（まとめると間の書き方の違いで見つからない）
    if (deleted.length > 1 && deleted.reduce((sum, index) => sum + units[index]!.nodes.length, 0) === inserted.length) {
      let offset = 0
      for (const index of deleted) {
        const own = inserted.slice(offset, offset + units[index]!.nodes.length)
        offset += own.length
        const text = patchHunk([index], own)
        pieces.push(text !== null
          ? { text, index, first: index }
          : { text: codec.serialize(own).replace(/^\n+|\n+$/g, ''), index: null, first: null })
      }
    } else if (inserted.length > 0) {
      const text = deleted.length > 0 ? patchHunk(deleted, inserted) : null
      if (text !== null) pieces.push({ text, index: deleted.at(-1)!, first: deleted[0]! })
      else pieces.push({ text: codec.serialize(inserted).replace(/^\n+|\n+$/g, ''), index: null, first: null })
    }
    // 参照リンクの定義（文書には出ない塊）は位置を変えずに残す
    for (const index of anchors) pieces.push({ text: units[index]!.raw, index, first: index })
    deleted = []
    anchors = []
    next = end
  }
  const patchHunk = (indices: number[], inserted: JSONContent[]): string | null => {
    const raw = indices.map((index, i) => units[index]!.raw + (i < indices.length - 1 ? units[index]!.gap : '')).join('')
    const before = codec.serialize(indices.flatMap((index) => units[index]!.nodes))
    const after = codec.serialize(inserted)
    const patched = patchSource(raw, before, after)
    if (patched === null) return null
    return sameNodes(parseUnit(codec, patched, definitions), inserted) ? patched : null
  }

  units.forEach((unit, index) => {
    const at = keptAt.get(index)
    if (at !== undefined) {
      flush(at)
      pieces.push({ text: unit.raw, index, first: index })
      next = at + unit.nodes.length
    } else if (unit.nodes.length === 0) {
      // 文書に出ない塊（参照リンクの定義など）は消さずに残す
      anchors.push(index)
    } else {
      deleted.push(index)
    }
  })
  flush(edited.length)

  // つなぐ。元で続いていた塊どうしは元の空行、それ以外は空行1つ
  let body = pieces[0]?.first === 0 ? model.leading : ''
  pieces.forEach((piece, i) => {
    const following = pieces[i + 1]
    const original = piece.index !== null ? units[piece.index]! : null
    if (following && original && following.index === piece.index! + 1) {
      body += piece.text + original.gap
    } else if (following) {
      body = (body + piece.text).replace(/\n*$/, '\n\n')
    } else if (original && piece.index === units.length - 1) {
      body += piece.text + original.gap
    } else {
      body = (body + piece.text).replace(/\n*$/, '') + trailingNewlines(model.body)
    }
  })

  // 最後に全体を読み直し、編集中の文書と同じときだけ使う（違えば正規形に戻す）。
  // 正規形でも同じに戻らない（TipTap の書き方で表せない内容。表の中の改行など）ときは、
  // 正規形にしても良くならないので、変えていない塊を元のまま残したほうを使う
  if (sameNodes(codec.parse(body), edited)) return finish(body)
  const fallback = canonicalBody(codec, edited, model.body)
  return finish(sameNodes(codec.parse(fallback), edited) ? fallback : body)
}

/** 元の文字列の行が、いくつそのまま残っているか（同じ行は数の分だけ） */
function keptLines(original: string, text: string): number {
  const counts = new Map<string, number>()
  for (const line of original.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1)
  let kept = 0
  for (const line of text.split('\n')) {
    const left = counts.get(line) ?? 0
    if (left > 0) { kept += 1; counts.set(line, left - 1) }
  }
  return kept
}

/**
 * 打鍵のたびに使う形。ディスクの内容（saved）からと、直前に写した内容（previous）からの両方で戻し、
 * ディスクの行をより多く残したほうを使う。
 *   saved から … 打ちかけの途中の形（行末の空白など、書き戻せない形）を経ても、仕上がりで元の書き方に戻れる
 *   previous から … 同じ塊の離れた2か所を直したときも、1か所ずつ当てられる
 */
export function reconcileEdit(saved: { text: string; model: SourceModel }, previous: SourceModel, edited: JSONContent[], codec: MarkdownCodec, editedFrontmatter: string): string {
  const fromSaved = reconcileMarkdown(saved.model, edited, codec, editedFrontmatter)
  if (previous === saved.model) return fromSaved
  const fromPrevious = reconcileMarkdown(previous, edited, codec, editedFrontmatter)
  if (fromSaved === fromPrevious) return fromSaved
  const original = saved.text.replace(/\r\n/g, '\n')
  return keptLines(original, fromPrevious.replace(/\r\n/g, '\n')) > keptLines(original, fromSaved.replace(/\r\n/g, '\n')) ? fromPrevious : fromSaved
}
