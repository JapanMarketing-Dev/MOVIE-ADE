import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { slashDeletesSeparately, slashTableTemplate, type SlashItemId } from './slashCommands'

/**
 * 「/」メニューで選んだ候補を実行する（SlashMenu.tsx から使う）。React を使わないので、画面を持たない TipTap のエディタで
 * 単体テストから流せる（test/unit/rich-markdown-slash.test.ts）。
 * 「/…」を消してから、その段落を塊に変える（表・区切り線はその位置に入れる）
 */
export function runSlashItem(editor: Editor, id: SlashItemId, range: { from: number; to: number }): void {
  const blockStart = editor.state.doc.resolve(range.from).before()
  // 表の行・列の操作は、消した後の文書から表の形を読み直させる（slashDeletesSeparately）
  if (slashDeletesSeparately(id)) editor.chain().focus().deleteRange(range).run()
  const chain = slashDeletesSeparately(id) ? editor.chain().focus() : editor.chain().focus().deleteRange(range)
  switch (id) {
    case 'heading1': chain.setNode('heading', { level: 1 }); break
    case 'heading2': chain.setNode('heading', { level: 2 }); break
    case 'heading3': chain.setNode('heading', { level: 3 }); break
    case 'bulletList': chain.toggleBulletList(); break
    case 'orderedList': chain.toggleOrderedList(); break
    case 'taskList': chain.toggleTaskList(); break
    case 'codeBlock': chain.setCodeBlock(); break
    case 'blockquote': chain.setBlockquote(); break
    case 'horizontalRule': chain.setHorizontalRule(); break
    case 'table': chain.insertContent(slashTableTemplate()); break
    case 'addRowAfter': chain.addRowAfter(); break
    case 'addColumnAfter': chain.addColumnAfter(); break
    case 'deleteRow': chain.deleteRow(); break
    case 'deleteColumn': chain.deleteColumn(); break
    case 'deleteTable': chain.deleteTable(); break
  }
  chain.run()
  if (id === 'table') {
    // 入れた表の最初のセル（見出しの行）へカーソルを移す
    let tablePos = -1
    editor.state.doc.descendants((node, pos) => {
      if (tablePos >= 0) return false
      if (node.type.name === 'table' && pos >= blockStart) { tablePos = pos; return false }
      return true
    })
    if (tablePos >= 0) {
      const { state, view } = editor
      view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(tablePos + 4))).scrollIntoView())
    }
  }
}
