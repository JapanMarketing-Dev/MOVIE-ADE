import { useEffect, useRef } from 'react'
import type { Editor } from '@tiptap/core'
import { detectSlashTrigger, slashDescriptionKey, slashLabelKey, slashScrollTop, type SlashContext, type SlashItem } from './slashCommands'
import { useT } from '../../lib/i18n'

/** 選んだ候補の実行は slashRun.ts（単体テストから流す） */
export { runSlashItem } from './slashRun'

/**
 * プレビューで編集するときの「/」メニュー（RichMarkdownEditor から使う）。
 * 開く条件・候補・絞り込みは slashCommands.ts（単体テストあり）。ここはエディタの位置を読むことと表示だけ（選んだ塊を入れるのは slashRun.ts）。
 */

/** 開いているメニュー。from〜to は消す「/…」の範囲（文書の位置）、x・y は「/」の画面の位置 */
export interface SlashState {
  context: SlashContext
  query: string
  from: number
  to: number
  left: number
  top: number
  bottom: number
}

/**
 * カーソルの位置から、メニューを開くか読む（選択の範囲がある・コードの中では開かない）。
 * 日本語入力の途中も開いたままにし、変換中の文字でも絞る（キーは入力の側が使うので、↑↓・Enter は変換が終わってから効く）
 */
export function readSlashState(editor: Editor): SlashState | null {
  const { state, view } = editor
  const selection = state.selection
  if (!selection.empty || !editor.isFocused) return null
  const $from = selection.$from
  const parent = $from.parent
  if (!parent.isTextblock || parent.type.spec.code) return null
  // 行の中の画像・改行も1文字として数える（文書の位置と文字の位置を合わせる。改行の後の「/」でも開く）
  const before = parent.textBetween(0, $from.parentOffset, undefined, '\n')
  const hit = detectSlashTrigger(before)
  if (!hit) return null
  let context: SlashContext = 'block'
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name
    if (name === 'tableCell' || name === 'tableHeader') { context = 'table'; break }
  }
  const from = $from.start() + hit.start
  const coords = view.coordsAtPos(from)
  return { context, query: hit.query, from, to: $from.pos, left: coords.left, top: coords.top, bottom: coords.bottom }
}

/** 候補の一覧（「/」の下、下に入らなければ上に出す）。マウスでも選べる（押してもエディタのフォーカスは外さない） */
export function SlashMenu({ state, items, index, onPick, onHover }: {
  state: SlashState
  items: readonly SlashItem[]
  index: number
  onPick: (item: SlashItem) => void
  onHover: (index: number) => void
}) {
  const t = useT()
  const listRef = useRef<HTMLDivElement>(null)
  // 選んだ候補が見えるよう、一覧の中だけをスクロールする（↑↓で枠の外へ出たとき）
  useEffect(() => {
    const list = listRef.current
    const item = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !item) return
    list.scrollTop = slashScrollTop({ top: item.offsetTop, height: item.offsetHeight }, { scrollTop: list.scrollTop, height: list.clientHeight })
  }, [index, items])
  if (items.length === 0) return null
  const MAX_HEIGHT = 320
  const WIDTH = 300
  const below = window.innerHeight - state.bottom >= MAX_HEIGHT + 8 || state.top < MAX_HEIGHT + 8
  const left = Math.max(8, Math.min(state.left, window.innerWidth - WIDTH - 8))
  const position = below ? { top: state.bottom + 4 } : { bottom: window.innerHeight - state.top + 4 }
  return (
    <div
      ref={listRef}
      className="rich-md__slash"
      role="listbox"
      style={{ left, width: WIDTH, maxHeight: MAX_HEIGHT, ...position }}
      onMouseDown={(event) => event.preventDefault()}
      data-testid="rich-md-slash-menu"
    >
      {items.map((item, i) => (
        <div
          key={item.id}
          role="option"
          aria-selected={i === index}
          className="rich-md__slash-item"
          // マウスを実際に動かしたときだけ選び直す（↑↓で一覧がスクロールしたとき、止まったままのポインタの下の項目に選択を取られない）
          onMouseMove={() => { if (i !== index) onHover(i) }}
          onClick={() => onPick(item)}
          data-testid={`rich-md-slash-${item.id}`}
        >
          <span className="rich-md__slash-text">
            <span className="rich-md__slash-label">{t(slashLabelKey(item.id))}</span>
            <span className="rich-md__slash-description">{t(slashDescriptionKey(item.id))}</span>
          </span>
          {item.syntax && <code className="rich-md__slash-syntax">{item.syntax}</code>}
        </div>
      ))}
    </div>
  )
}
