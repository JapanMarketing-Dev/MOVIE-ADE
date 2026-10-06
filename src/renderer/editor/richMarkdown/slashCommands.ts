import type { JSONContent } from '@tiptap/core'
import type { MessageKey } from '@shared/i18n'

/**
 * プレビューで編集するときの「/」メニュー（スラッシュコマンド）の中身。DOM・エディタを使わないので単体テストから使う。
 *
 * 行の頭（または空白の後）で「/」を打つと候補を出し、続けて打った文字で絞る。選ぶと「/…」を消して塊を入れる。
 * 表の中では、表の外の塊（GFM のセルには入れられない）の代わりに、行・列の追加と削除を出す。
 * 実際の書き換えは RichMarkdownEditor が TipTap のコマンドで行う（表は slashTableTemplate を入れる）。
 */

export type SlashItemId =
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'table'
  | 'codeBlock'
  | 'blockquote'
  | 'horizontalRule'
  | 'addRowAfter'
  | 'addColumnAfter'
  | 'deleteRow'
  | 'deleteColumn'
  | 'deleteTable'

/** どこで出すか。block は表の外、table は表のセルの中 */
export type SlashContext = 'block' | 'table'

export interface SlashItem {
  id: SlashItemId
  context: SlashContext
  /** 絞り込みに使う英語の別名（言語を問わず効く） */
  keywords: readonly string[]
  /** 説明に添える Markdown の書き方（ソースで同じものを書くとき） */
  syntax?: string
  /**
   * 「/」の後に打つ Markdown の記号（空白を含まない形）。「/##」と打てば見出し2が先頭に来て、続けて空白を打てばそのまま変わる。
   * 「/」を消して記法を打ち直さなくてよいように（行の頭で「## 」と打てば、メニューを使わなくても入力規則で変わる）
   */
  marks?: readonly string[]
}

export const SLASH_ITEMS: readonly SlashItem[] = [
  { id: 'heading1', context: 'block', keywords: ['h1', 'heading', 'title'], syntax: '# ', marks: ['#'] },
  { id: 'heading2', context: 'block', keywords: ['h2', 'heading', 'subtitle'], syntax: '## ', marks: ['##'] },
  { id: 'heading3', context: 'block', keywords: ['h3', 'heading'], syntax: '### ', marks: ['###'] },
  { id: 'bulletList', context: 'block', keywords: ['ul', 'bullet', 'list', 'unordered'], syntax: '- ', marks: ['-', '*', '+'] },
  { id: 'orderedList', context: 'block', keywords: ['ol', 'ordered', 'numbered', 'list'], syntax: '1. ', marks: ['1.', '1)'] },
  { id: 'taskList', context: 'block', keywords: ['todo', 'task', 'checkbox', 'checklist'], syntax: '- [ ] ', marks: ['[]', '[x]', '-[]', '-[x]'] },
  { id: 'table', context: 'block', keywords: ['table', 'grid'], syntax: '| a | b |', marks: ['|'] },
  { id: 'codeBlock', context: 'block', keywords: ['code', 'pre', 'fence', 'mermaid'], syntax: '```', marks: ['```', '~~~'] },
  { id: 'blockquote', context: 'block', keywords: ['quote', 'blockquote'], syntax: '> ', marks: ['>'] },
  { id: 'horizontalRule', context: 'block', keywords: ['hr', 'divider', 'rule', 'separator'], syntax: '---', marks: ['---', '***', '___'] },
  { id: 'addRowAfter', context: 'table', keywords: ['row', 'add', 'insert'] },
  { id: 'addColumnAfter', context: 'table', keywords: ['column', 'col', 'add', 'insert'] },
  { id: 'deleteRow', context: 'table', keywords: ['row', 'delete', 'remove'] },
  { id: 'deleteColumn', context: 'table', keywords: ['column', 'col', 'delete', 'remove'] },
  { id: 'deleteTable', context: 'table', keywords: ['table', 'delete', 'remove'] }
]

export function slashLabelKey(id: SlashItemId): MessageKey {
  return `markdown.slash.${id}`
}
export function slashDescriptionKey(id: SlashItemId): MessageKey {
  return `markdown.slash.${id}.description`
}

/** 比べる形（全角英数を半角に、大文字を小文字に） */
function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim()
}

/**
 * 打った文字で絞る。空なら全部。Markdown の記号（marks）とぴったり同じもの → 名前（その言語）・英語の別名・記号のどれかが
 * 頭から一致するもの → 途中に含むものの順（「/#」は見出し1・2・3、「/##」は見出し2が先頭）。
 * label は表示する名前（t で引いたもの）。全角の記号（＃ や －）も半角と同じに扱う
 */
export function filterSlashItems(
  items: readonly SlashItem[],
  context: SlashContext,
  query: string,
  label: (item: SlashItem) => string
): SlashItem[] {
  const inContext = items.filter((item) => item.context === context)
  const q = fold(query)
  if (q === '') return inContext
  const exact: SlashItem[] = []
  const prefix: SlashItem[] = []
  const contains: SlashItem[] = []
  for (const item of inContext) {
    const marks = (item.marks ?? []).map(fold)
    const words = [fold(label(item)), ...item.keywords.map(fold), ...marks]
    if (marks.includes(q)) exact.push(item)
    else if (words.some((w) => w.startsWith(q))) prefix.push(item)
    else if (words.some((w) => w.includes(q))) contains.push(item)
  }
  return [...exact, ...prefix, ...contains]
}

/**
 * 「/」の後に打ったのが、ある候補の Markdown の記号そのものか（「/##」「/-」「/1.」）。そうなら、続けて空白を打ったときに
 * その候補を選ぶ（行の頭で「## 」と打ったのと同じになる）。数字は何でもよい（「/3.」も番号付きリスト）
 */
export function slashMarkItem(items: readonly SlashItem[], context: SlashContext, query: string): SlashItem | null {
  const q = fold(query).replace(/^\d+([.)])$/, '1$1')
  if (q === '') return null
  return items.find((item) => item.context === context && (item.marks ?? []).some((mark) => fold(mark) === q)) ?? null
}

/** 「/」として受ける文字（日本語入力の全角の ／ も） */
const SLASH_TRIGGER_RE = /(?:^|[\s　])([/／])([^\s　/／]{0,32})$/

/**
 * カーソルの前の文字（同じ段落の頭から）を見て、メニューを開くか決める。
 * 開くなら、消す範囲（「/」からカーソルまで。段落の頭からの位置）と、絞る文字を返す
 */
export function detectSlashTrigger(textBefore: string): { start: number; query: string } | null {
  const match = SLASH_TRIGGER_RE.exec(textBefore)
  if (!match) return null
  const query = match[2] ?? ''
  return { start: textBefore.length - query.length - 1, query }
}

/**
 * 「/…」を消すのを、塊を入れる操作と別の変更にするか。表の行・列の操作（prosemirror-tables）は TipTap の chain の中だと
 * 消す前の文書から表の形を読み、消した後の文書に入れるので、列がずれて2列増える（E2E で見つけた）。表の操作は先に消してから行う
 */
export function slashDeletesSeparately(id: SlashItemId): boolean {
  return SLASH_ITEMS.some((item) => item.id === id && item.context === 'table')
}

/** 選んだ候補の位置を上下に動かす（端で反対へ回る） */
export function moveSlashIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return (((index + delta) % count) + count) % count
}

function cell(type: 'tableHeader' | 'tableCell'): JSONContent {
  return { type, attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: 'paragraph' }] }
}

/**
 * 「/表」で入れる表。見出しの行を含めて rows 行 × cols 列（GFM の表は見出しの行が要る）。
 * 保存すると | | の表になる（test/unit/rich-markdown-slash.test.ts で GFM として読み戻せることを確かめる）
 */
export function slashTableTemplate(rows = 3, cols = 3): JSONContent {
  const r = Math.max(2, Math.floor(rows))
  const c = Math.max(1, Math.floor(cols))
  return {
    type: 'table',
    content: Array.from({ length: r }, (_, i) => ({
      type: 'tableRow',
      content: Array.from({ length: c }, () => cell(i === 0 ? 'tableHeader' : 'tableCell'))
    }))
  }
}

/**
 * 選んだ候補が一覧の枠に見えるようにするスクロールの位置（上にはみ出したら上端へ、下にはみ出したら下端へ。見えていればそのまま）。
 * scrollIntoView は一覧の外側（エディタのページ）までスクロールさせることがあるので、一覧の中だけを動かす
 */
export function slashScrollTop(item: { top: number; height: number }, view: { scrollTop: number; height: number }, padding = 4): number {
  if (item.top - padding < view.scrollTop) return Math.max(0, item.top - padding)
  if (item.top + item.height + padding > view.scrollTop + view.height) return item.top + item.height + padding - view.height
  return view.scrollTop
}
