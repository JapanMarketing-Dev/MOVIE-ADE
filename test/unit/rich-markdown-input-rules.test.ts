import { afterEach, describe, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import { richMarkdownExtensions } from '../../src/renderer/editor/richMarkdown/codec'
import {
  FULLWIDTH_BULLET_RE,
  FULLWIDTH_CODE_RE,
  FULLWIDTH_HEADING_RE,
  FULLWIDTH_ORDERED_RE,
  FULLWIDTH_QUOTE_RE,
  MarkdownInputRules,
  TASK_RE
} from '../../src/renderer/editor/richMarkdown/inputRules'

/**
 * プレビューで編集するときの Markdown の入力規則（inputRules.ts）。
 * 行の頭で「## 」「- [ ] 」や全角の「＃　」と打てば、メニューを使わなくても塊に変わることを、画面を持たない TipTap のエディタで確かめる。
 */

const editors: Editor[] = []
afterEach(() => { while (editors.length) editors.pop()!.destroy() })

function editorWith(content: JSONContent[] = [{ type: 'paragraph' }]): Editor {
  const editor = new Editor({ element: null, extensions: [...richMarkdownExtensions(), MarkdownInputRules], content: { type: 'doc', content } })
  editors.push(editor)
  // 画面を持たないエディタは、プラグイン（入力規則）を状態に入れない（ビューを作るときに入れる）。ここで入れる
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }))
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  return editor
}

/** 1文字ずつ打つ（入力規則の handleTextInput を通し、どれも当たらなければそのまま入れる） */
function type(editor: Editor, text: string): void {
  for (const ch of text) {
    const { from, to } = editor.state.selection
    const view = editor.view
    const handled = editor.state.plugins.some((plugin) => plugin.props.handleTextInput?.call(plugin, view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)))
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to))
  }
}

const top = (editor: Editor) => editor.getJSON().content ?? []

describe('正規表現', () => {
  it('全角の記号だけを受ける（半角だけのものは既定の規則に任せる）', () => {
    expect(FULLWIDTH_HEADING_RE.exec('＃＃　')?.[1]).toBe('＃＃')
    expect(FULLWIDTH_HEADING_RE.exec('#＃ ')?.[1]).toBe('#＃')
    expect(FULLWIDTH_HEADING_RE.test('## ')).toBe(false)
    expect(FULLWIDTH_HEADING_RE.test('＃＃＃＃＃＃＃ ')).toBe(false)
    expect(FULLWIDTH_BULLET_RE.test('－　')).toBe(true)
    expect(FULLWIDTH_BULLET_RE.test('- ')).toBe(false)
    expect(FULLWIDTH_ORDERED_RE.exec('１．　')?.[1]).toBe('１')
    expect(FULLWIDTH_ORDERED_RE.exec('12． ')?.[1]).toBe('12')
    expect(FULLWIDTH_ORDERED_RE.test('1. ')).toBe(false)
    expect(FULLWIDTH_QUOTE_RE.test('＞　')).toBe(true)
    expect(FULLWIDTH_CODE_RE.exec('｀｀｀ts ')?.[1]).toBe('ts')
    expect(TASK_RE.test('[ ] ')).toBe(true)
    expect(TASK_RE.exec('［ｘ］　')?.[1]).toBe('ｘ')
    expect(TASK_RE.test('[] ')).toBe(true)
    expect(TASK_RE.test('[a] ')).toBe(false)
  })
})

describe('行の頭の Markdown の記法で塊に変わる', () => {
  it('「# 」「## 」「### 」は見出し（半角は既定の規則のまま）', () => {
    for (const [typed, level] of [['# ', 1], ['## ', 2], ['### ', 3]] as const) {
      const editor = editorWith()
      type(editor, `${typed}Title`)
      expect(top(editor)[0], typed).toMatchObject({ type: 'heading', attrs: { level }, content: [{ type: 'text', text: 'Title' }] })
    }
  })

  it('全角の「＃＃　」も見出し2になる（日本語入力のまま打てる）', () => {
    const editor = editorWith()
    type(editor, '＃＃　見出し')
    expect(top(editor)[0]).toMatchObject({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '見出し' }] })
  })

  it('「- 」「－　」は箇条書き、「1. 」「１．　」は番号付き、「> 」「＞　」は引用', () => {
    const cases: [string, string][] = [['- ', 'bulletList'], ['－　', 'bulletList'], ['1. ', 'orderedList'], ['１．　', 'orderedList'], ['> ', 'blockquote'], ['＞　', 'blockquote']]
    for (const [typed, kind] of cases) {
      const editor = editorWith()
      type(editor, `${typed}x`)
      expect(top(editor)[0]?.type, typed).toBe(kind)
    }
  })

  it('「３．　」は 3 から始まる番号付きリスト', () => {
    const editor = editorWith()
    type(editor, '３．　x')
    expect(top(editor)[0]).toMatchObject({ type: 'orderedList', attrs: { start: 3 } })
  })

  it('「```」「｀｀｀　」はコードブロック', () => {
    for (const typed of ['``` ', '｀｀｀　']) {
      const editor = editorWith()
      type(editor, `${typed}code`)
      expect(top(editor)[0], typed).toMatchObject({ type: 'codeBlock', content: [{ type: 'text', text: 'code' }] })
    }
  })

  it('「[ ] 」「[x] 」「［　］　」はチェックリスト（チェックの有無も）', () => {
    for (const [typed, checked] of [['[ ] ', false], ['[x] ', true], ['［　］　', false], ['［ｘ］　', true]] as const) {
      const editor = editorWith()
      type(editor, `${typed}todo`)
      expect(top(editor)[0], typed).toMatchObject({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'todo' }] }] }] })
    }
  })

  it('「- [ ] 」は箇条書きの中のチェックボックスの文字にならず、チェックリストになる', () => {
    const editor = editorWith()
    type(editor, '- [ ] todo')
    expect(top(editor)).toHaveLength(1)
    expect(top(editor)[0]).toMatchObject({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'todo' }] }] }] })
  })

  it('「- [x] 」はチェック済みの項目', () => {
    const editor = editorWith()
    type(editor, '- [x] done')
    expect(top(editor)[0]).toMatchObject({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true } }] })
  })

  it('文の途中の「# 」「[ ] 」は変えない', () => {
    const editor = editorWith()
    type(editor, 'a # b [ ] c')
    expect(top(editor)).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: 'a # b [ ] c' }] }])
  })
})
