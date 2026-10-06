import { Extension, InputRule, textblockTypeInputRule, wrappingInputRule } from '@tiptap/core'

/**
 * プレビューで編集するときの Markdown の入力規則を足す（行の頭で「## 」と打てば見出しになる、など）。
 *
 * 半角の「# 」「- 」「1. 」「> 」「```」「---」「[ ] 」は StarterKit・TaskItem の入力規則がそのまま変える。ここで足すのは次の2つ:
 *   - 「- [ ] 」: 「- 」で箇条書きになった後の「[ ] 」を、箇条書きの項目のままにせずチェックリストへ変える
 *     （TipTap の既定ではチェックボックスの文字が残るか、箇条書きの中にチェックリストが入れ子になる）
 *   - 日本語入力のまま打った全角の記号（＃　・－　・１．　・＞　・［　］　・｀｀｀）。半角に直して打ち直さなくてよいように
 * スキーマは変えない（保存の変換 codec.ts と同じ一式で読み書きするため。拡張は編集のエディタにだけ足す）。
 * 正規表現は単体テストから使う（test/unit/rich-markdown-input-rules.test.ts）。
 */

/** 全角の見出し（＃ を含むものだけ。半角だけの「## 」は Heading の既定の規則が変える） */
export const FULLWIDTH_HEADING_RE = /^(?=[#＃]*＃)([#＃]{1,6})[\s　]$/
/** 全角の箇条書き（－ ＊ ＋） */
export const FULLWIDTH_BULLET_RE = /^\s*([－＊＋])[\s　]$/
/** 全角の番号付きリスト（１．・1．・１.） */
export const FULLWIDTH_ORDERED_RE = /^(?=[0-9０-９]*[０-９]|[0-9]+．)([0-9０-９]+)[.．][\s　]$/
/** 全角の引用 */
export const FULLWIDTH_QUOTE_RE = /^\s*＞[\s　]$/
/** 全角のコードブロック（｀｀｀ の後ろに言語名を付けてもよい） */
export const FULLWIDTH_CODE_RE = /^｀｀｀([a-zA-Z0-9]+)?[\s　]$/
/** チェックリスト。[ ] [x] [] と、全角の ［　］［ｘ］ も */
export const TASK_RE = /^\s*[[［]([ 　xXｘＸ])?[\]］][\s　]$/

/** 全角の数字を半角に */
function halfWidthDigits(text: string): string {
  return text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

export const MarkdownInputRules = Extension.create({
  name: 'ferretMarkdownInputRules',
  // 既定の規則（TaskItem の「[ ] 」など）より先に当てる
  priority: 1000,
  addInputRules() {
    const { schema } = this.editor
    const rules: InputRule[] = []
    const { heading, bulletList, orderedList, blockquote, codeBlock } = schema.nodes
    if (heading) {
      rules.push(textblockTypeInputRule({ find: FULLWIDTH_HEADING_RE, type: heading, getAttributes: (match) => ({ level: match[1]!.length }) }))
    }
    if (bulletList) rules.push(wrappingInputRule({ find: FULLWIDTH_BULLET_RE, type: bulletList }))
    if (orderedList) {
      rules.push(wrappingInputRule({
        find: FULLWIDTH_ORDERED_RE,
        type: orderedList,
        getAttributes: (match) => ({ start: Number(halfWidthDigits(match[1]!)) }),
        joinPredicate: (match, node) => node.childCount + (node.attrs.start as number) === Number(halfWidthDigits(match[1]!))
      }))
    }
    if (blockquote) rules.push(wrappingInputRule({ find: FULLWIDTH_QUOTE_RE, type: blockquote }))
    if (codeBlock) {
      rules.push(textblockTypeInputRule({ find: FULLWIDTH_CODE_RE, type: codeBlock, getAttributes: (match) => ({ language: match[1] ?? null }) }))
    }
    if (schema.nodes.taskList && schema.nodes.taskItem) {
      rules.push(new InputRule({
        find: TASK_RE,
        handler: ({ state, range, match, chain }) => {
          // すでにチェックリストの中なら変えない（打った文字のまま）
          const $from = state.doc.resolve(range.from)
          for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === 'taskItem') return null
          const checked = /[xXｘＸ]/.test(match[1] ?? '')
          // 箇条書きの項目の中なら、その項目をチェックリストへ移す（toggleTaskList が箇条書きから外して包み直す）
          chain().deleteRange(range).toggleTaskList().updateAttributes('taskItem', { checked }).run()
        }
      }))
    }
    return rules
  }
})
