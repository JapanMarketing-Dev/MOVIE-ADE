import { describe, expect, it } from 'vitest'
import { marked } from 'marked'
import { Editor } from '@tiptap/core'
import { createMarkdownCodec, richMarkdownExtensions } from '../../src/renderer/editor/richMarkdown/codec'
import { runSlashItem } from '../../src/renderer/editor/richMarkdown/slashRun'
import {
  SLASH_ITEMS,
  detectSlashTrigger,
  filterSlashItems,
  moveSlashIndex,
  slashDeletesSeparately,
  slashDescriptionKey,
  slashLabelKey,
  slashMarkItem,
  slashScrollTop,
  slashTableTemplate,
  type SlashItem
} from '../../src/renderer/editor/richMarkdown/slashCommands'
import { en } from '../../src/shared/i18n/en'
import { ja } from '../../src/shared/i18n/ja'

/**
 * プレビューで編集するときの「/」メニュー（slashCommands.ts）。
 * 開く条件・絞り込み・表のひな形が GFM の表として保存され読み戻せることを固定する。
 */
const codec = createMarkdownCodec()
const enLabel = (item: SlashItem) => en[slashLabelKey(item.id)]
const jaLabel = (item: SlashItem) => ja[slashLabelKey(item.id)]
const ids = (items: SlashItem[]) => items.map((item) => item.id)

describe('detectSlashTrigger', () => {
  it('行の頭の「/」で開き、続けて打った文字で絞る', () => {
    expect(detectSlashTrigger('/')).toEqual({ start: 0, query: '' })
    expect(detectSlashTrigger('/tab')).toEqual({ start: 0, query: 'tab' })
    expect(detectSlashTrigger('／表')).toEqual({ start: 0, query: '表' })
  })

  it('空白の後の「/」でも開く（消す範囲は「/」から）', () => {
    expect(detectSlashTrigger('メモ /h')).toEqual({ start: 3, query: 'h' })
    expect(detectSlashTrigger('memo　/')).toEqual({ start: 5, query: '' })
  })

  it('語の途中・パス・空白を挟んだ後では開かない', () => {
    expect(detectSlashTrigger('src/')).toBeNull()
    expect(detectSlashTrigger('a/b')).toBeNull()
    expect(detectSlashTrigger('/usr/bin')).toBeNull()
    expect(detectSlashTrigger('/table ')).toBeNull()
    expect(detectSlashTrigger('https://')).toBeNull()
    expect(detectSlashTrigger('')).toBeNull()
  })
})

describe('filterSlashItems', () => {
  it('表の外では塊の候補、表の中では行・列の候補だけを出す', () => {
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', '', enLabel))).toEqual([
      'heading1', 'heading2', 'heading3', 'bulletList', 'orderedList', 'taskList', 'table', 'codeBlock', 'blockquote', 'horizontalRule'
    ])
    expect(ids(filterSlashItems(SLASH_ITEMS, 'table', '', enLabel))).toEqual(['addRowAfter', 'addColumnAfter', 'deleteRow', 'deleteColumn', 'deleteTable'])
  })

  it('その言語の名前でも英語の別名でも絞れる（頭から一致するものが先）', () => {
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', '表', jaLabel))).toEqual(['table'])
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', 'table', jaLabel))).toEqual(['table'])
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', 'h2', jaLabel))).toEqual(['heading2'])
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', 'ＴＯＤＯ', enLabel))).toEqual(['taskList'])
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', 'list', enLabel))).toEqual(['bulletList', 'orderedList', 'taskList'])
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', '見出し', jaLabel))).toEqual(['heading1', 'heading2', 'heading3'])
    expect(ids(filterSlashItems(SLASH_ITEMS, 'table', 'col', enLabel))).toEqual(['addColumnAfter', 'deleteColumn'])
    expect(filterSlashItems(SLASH_ITEMS, 'block', 'zzz', enLabel)).toEqual([])
  })

  it('どの候補にも名前と説明がある', () => {
    for (const item of SLASH_ITEMS) {
      expect(en[slashLabelKey(item.id)]).toBeTruthy()
      expect(en[slashDescriptionKey(item.id)]).toBeTruthy()
    }
  })
})

describe('「/」の後の Markdown の記号', () => {
  it('「/#」「/##」は記号がぴったりの見出しが先頭（「/」を消して # を打ち直さなくてよい）', () => {
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', '#', jaLabel))).toEqual(['heading1', 'heading2', 'heading3'])
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', '##', jaLabel))).toEqual(['heading2', 'heading3'])
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', '###', enLabel))).toEqual(['heading3'])
  })

  it('「/-」は箇条書きが先頭、「/1.」は番号付き、「/>」は引用、「/```」はコード、「/[]」はチェックリスト、「/|」は表', () => {
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', '-', jaLabel))[0]).toBe('bulletList')
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', '-', jaLabel))).toContain('horizontalRule')
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', '1.', jaLabel))).toEqual(['orderedList'])
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', '>', jaLabel))).toEqual(['blockquote'])
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', '```', jaLabel))).toEqual(['codeBlock'])
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', '[]', jaLabel))).toEqual(['taskList'])
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', '|', jaLabel))).toEqual(['table'])
  })

  it('全角の記号（日本語入力のまま）でも同じ', () => {
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', '＃＃', jaLabel))).toEqual(['heading2', 'heading3'])
    expect(ids(filterSlashItems(SLASH_ITEMS, 'block', '＞', jaLabel))).toEqual(['blockquote'])
  })

  it('記号そのものを打った後の空白で選ぶ候補（数字は何でもよい）', () => {
    const pick = (query: string, context: 'block' | 'table' = 'block') => slashMarkItem(SLASH_ITEMS, context, query)?.id ?? null
    expect(pick('#')).toBe('heading1')
    expect(pick('##')).toBe('heading2')
    expect(pick('＃＃＃')).toBe('heading3')
    expect(pick('-')).toBe('bulletList')
    expect(pick('*')).toBe('bulletList')
    expect(pick('3.')).toBe('orderedList')
    expect(pick('１．')).toBe('orderedList')
    expect(pick('[x]')).toBe('taskList')
    expect(pick('---')).toBe('horizontalRule')
    expect(pick('```')).toBe('codeBlock')
    // 名前・別名の途中では選ばない（空白は文字として入る）
    expect(pick('')).toBeNull()
    expect(pick('h1')).toBeNull()
    expect(pick('見出し')).toBeNull()
    expect(pick('--')).toBeNull()
    // 表の中では表の外の塊を選ばない
    expect(pick('#', 'table')).toBeNull()
  })
})

describe('slashScrollTop', () => {
  const view = { scrollTop: 100, height: 200 }
  it('見えていればそのまま', () => {
    expect(slashScrollTop({ top: 150, height: 40 }, view)).toBe(100)
  })
  it('上にはみ出したら上端へ、下にはみ出したら下端へ', () => {
    expect(slashScrollTop({ top: 80, height: 40 }, view)).toBe(76)
    expect(slashScrollTop({ top: 280, height: 40 }, view)).toBe(124)
    expect(slashScrollTop({ top: 2, height: 40 }, view)).toBe(0)
  })
})

describe('moveSlashIndex', () => {
  it('端で反対へ回る', () => {
    expect(moveSlashIndex(0, -1, 3)).toBe(2)
    expect(moveSlashIndex(2, 1, 3)).toBe(0)
    expect(moveSlashIndex(1, 1, 3)).toBe(2)
    expect(moveSlashIndex(0, 1, 0)).toBe(0)
  })
})

describe('slashTableTemplate', () => {
  it('空の 3×3 の表は GFM の表として保存され、読み戻すと同じ表になる', () => {
    const table = slashTableTemplate()
    const markdown = codec.serialize([table])
    const tokens = marked.lexer(markdown, { gfm: true })
    const gfm = tokens.find((token) => token.type === 'table')
    expect(gfm, markdown).toBeTruthy()
    expect((gfm as { header: unknown[] }).header).toHaveLength(3)
    expect((gfm as { rows: unknown[] }).rows).toHaveLength(2)
    expect(codec.parse(markdown)).toEqual(codec.parse(codec.serialize(codec.parse(markdown))))
    expect(codec.parse(markdown)[0]).toMatchObject({ type: 'table' })
  })

  it('セルに書いた文字は、その位置のまま保存される', () => {
    const table = slashTableTemplate(2, 2)
    const texts = [['Name', 'Size'], ['a', '1']]
    table.content!.forEach((row, r) => row.content!.forEach((cell, c) => {
      cell.content = [{ type: 'paragraph', content: [{ type: 'text', text: texts[r]![c]! }] }]
    }))
    const markdown = codec.serialize([table])
    const gfm = marked.lexer(markdown, { gfm: true }).find((token) => token.type === 'table') as { header: { text: string }[]; rows: { text: string }[][] }
    expect(gfm.header.map((h) => h.text)).toEqual(['Name', 'Size'])
    expect(gfm.rows.map((row) => row.map((c) => c.text))).toEqual([['a', '1']])
    expect(codec.parse(markdown)).toEqual(codec.parse(codec.serialize([table])))
  })

  it('見出しの行は必ず持つ（2行より少なくしない）', () => {
    expect(slashTableTemplate(1, 0).content).toHaveLength(2)
    expect(slashTableTemplate(1, 0).content![0]!.content).toHaveLength(1)
  })
})

describe('表の中の「/」: 行・列の操作は「/…」を消してから行う（画面を持たない TipTap のエディタで runSlashItem を流す）', () => {
  it('表の操作だけを別の変更にする（表の外の塊は消すのと同じ変更）', () => {
    for (const item of SLASH_ITEMS) expect(slashDeletesSeparately(item.id), item.id).toBe(item.context === 'table')
  })

  /** 見出しの行 A B C、本文の2列目に打った「/…」の 3×3 の表。カーソルは「/…」の後 */
  function tableEditor(typed: string): { editor: Editor; range: { from: number; to: number } } {
    const table = slashTableTemplate()
    const texts = [['A', 'B', 'C'], ['d', typed, ''], ['', '', '']]
    table.content!.forEach((row, r) => row.content!.forEach((cell, c) => {
      if (texts[r]![c]) cell.content = [{ type: 'paragraph', content: [{ type: 'text', text: texts[r]![c]! }] }]
    }))
    const editor = new Editor({ element: null, extensions: richMarkdownExtensions(), content: { type: 'doc', content: [table] } })
    let to = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === typed) to = pos + node.nodeSize
      return to < 0
    })
    editor.commands.setTextSelection(to)
    return { editor, range: { from: to - typed.length, to } }
  }
  const rows = (editor: Editor): string[][] => {
    const out: string[][] = []
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'tableRow') out.push(Array.from({ length: node.childCount }, (_, i) => node.child(i).textContent))
      return node.type.name !== 'tableRow'
    })
    return out
  }

  it('列を足す: どの行も4列で、書いた文字の位置はずれない（E2E で2列増えてずれていた）', () => {
    const { editor, range } = tableEditor('/column')
    runSlashItem(editor, 'addColumnAfter', range)
    expect(rows(editor)).toEqual([['A', 'B', '', 'C'], ['d', '', '', ''], ['', '', '', '']])
    editor.destroy()
  })

  it('行を足す・列と行を消す: 「/…」は残らず、表の形は揃ったまま', () => {
    const row = tableEditor('/row')
    runSlashItem(row.editor, 'addRowAfter', row.range)
    expect(rows(row.editor)).toEqual([['A', 'B', 'C'], ['d', '', ''], ['', '', ''], ['', '', '']])
    const column = tableEditor('/delete')
    runSlashItem(column.editor, 'deleteColumn', column.range)
    expect(rows(column.editor)).toEqual([['A', 'C'], ['d', ''], ['', '']])
    const deleteRow = tableEditor('/delete')
    runSlashItem(deleteRow.editor, 'deleteRow', deleteRow.range)
    expect(rows(deleteRow.editor)).toEqual([['A', 'B', 'C'], ['', '', '']])
    for (const e of [row, column, deleteRow]) e.editor.destroy()
  })

  it('（再発の理由）消すのと列を足すのを1つの chain にすると、行ごとの列の数が揃わない', () => {
    const { editor, range } = tableEditor('/column')
    editor.chain().deleteRange(range).addColumnAfter().run()
    expect(new Set(rows(editor).map((r) => r.length)).size).toBeGreaterThan(1)
    editor.destroy()
  })
})
