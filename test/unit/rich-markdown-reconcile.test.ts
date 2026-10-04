import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { createMarkdownCodec } from '../../src/renderer/editor/richMarkdown/codec'
import { buildSourceModel, patchSource, reconcileEdit, reconcileMarkdown, splitFrontmatter } from '../../src/renderer/editor/richMarkdown/reconcile'

/**
 * プレビューで編集したときの Markdown の往復（reconcile.ts）。
 * 変えていない部分は元の文字列のまま残ること、変えた塊の中も元の書き方をできるだけ保つこと、
 * 保てないときにどこまで TipTap の書き方（正規形）になるかを固定する。
 */
const codec = createMarkdownCodec()

const DOC = `---
title: 設計書
tags: [a, b]
---

Setext Title
============

Intro paragraph with *emphasis* and __strong__.


* first item
* second item
    * nested item

| Name | Size |
|:-----|-----:|
| a    |    1 |
| bb   |   22 |

- [ ] todo
- [x] done

1) one
2) two

\`\`\`mermaid
graph TD; A-->B
\`\`\`

See [the docs][docs].

[docs]: https://example.com/docs
`

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 文書の中の最初の text ノードで from を含むものを書き換える */
function replaceText(nodes: JSONContent[], from: string, to: string): JSONContent[] {
  const next = clone(nodes)
  let done = false
  const walk = (node: JSONContent) => {
    if (done) return
    if (node.type === 'text' && typeof node.text === 'string' && node.text.includes(from)) {
      node.text = node.text.replace(from, to)
      done = true
      return
    }
    node.content?.forEach(walk)
  }
  next.forEach(walk)
  if (!done) throw new Error(`not found: ${from}`)
  return next
}

function edit(source: string, change: (nodes: JSONContent[]) => JSONContent[], frontmatter?: string): string {
  const model = buildSourceModel(source, codec)
  return reconcileMarkdown(model, change(model.nodes), codec, frontmatter)
}

describe('rich markdown reconcile', () => {
  it('maps every block of a typical design doc to its source', () => {
    const model = buildSourceModel(DOC, codec)
    expect(model.units).not.toBeNull()
    expect(model.frontmatter).toBe('---\ntitle: 設計書\ntags: [a, b]\n---\n')
  })

  it('returns the original bytes when nothing changed', () => {
    expect(edit(DOC, (nodes) => nodes)).toBe(DOC)
  })

  it('returns the original bytes after an edit is undone (same document)', () => {
    const model = buildSourceModel(DOC, codec)
    const once = reconcileMarkdown(model, replaceText(model.nodes, 'Intro', 'Intro!'), codec)
    expect(once).not.toBe(DOC)
    expect(reconcileMarkdown(model, clone(model.nodes), codec)).toBe(DOC)
  })

  it('edits a paragraph and leaves every other block byte-for-byte', () => {
    const out = edit(DOC, (nodes) => replaceText(nodes, 'Intro paragraph', 'Updated paragraph'))
    expect(out).toBe(DOC.replace('Intro paragraph', 'Updated paragraph'))
  })

  it('keeps the emphasis markers of the edited paragraph (_ / * / __)', () => {
    const out = edit(DOC, (nodes) => replaceText(nodes, 'emphasis', 'emphasis words'))
    expect(out).toBe(DOC.replace('*emphasis*', '*emphasis words*'))
    expect(out).toContain('__strong__')
  })

  it('edits a setext heading without turning it into an ATX heading', () => {
    const out = edit(DOC, (nodes) => replaceText(nodes, 'Setext Title', 'Setext Title v2'))
    expect(out).toContain('Setext Title v2\n============')
    expect(out).not.toContain('# Setext')
  })

  it('edits one list item and keeps the * markers and the 4-space nesting', () => {
    const out = edit(DOC, (nodes) => replaceText(nodes, 'second item', 'second item (edited)'))
    expect(out).toBe(DOC.replace('* second item', '* second item (edited)'))
    expect(out).toContain('    * nested item')
  })

  it('edits a table cell and keeps the other rows aligned as written', () => {
    const out = edit(DOC, (nodes) => replaceText(nodes, 'bb', 'cc'))
    expect(out).toBe(DOC.replace('| bb   |', '| cc   |'))
  })

  it('toggles a checkbox in place', () => {
    const out = edit(DOC, (nodes) => {
      const next = clone(nodes)
      const list = next.find((node) => node.type === 'taskList')!
      list.content![0]!.attrs = { ...list.content![0]!.attrs, checked: true }
      return next
    })
    expect(out).toBe(DOC.replace('- [ ] todo', '- [x] todo'))
  })

  it('keeps the ") " ordered list delimiter of an edited list', () => {
    const out = edit(DOC, (nodes) => replaceText(nodes, 'two', 'two!'))
    expect(out).toBe(DOC.replace('2) two', '2) two!'))
  })

  it('edits the source of a mermaid block', () => {
    const out = edit(DOC, (nodes) => replaceText(nodes, 'A-->B', 'A-->C'))
    expect(out).toBe(DOC.replace('A-->B', 'A-->C'))
  })

  it('keeps reference-style links and their definitions', () => {
    const out = edit(DOC, (nodes) => replaceText(nodes, 'See ', 'Read '))
    expect(out).toBe(DOC.replace('See [the docs][docs]', 'Read [the docs][docs]'))
    expect(out).toContain('[docs]: https://example.com/docs')
  })

  it('splits a paragraph (Enter) and keeps the rest of the file', () => {
    const out = edit(DOC, (nodes) => {
      const next = clone(nodes)
      const index = next.findIndex((node) => node.type === 'paragraph')
      next.splice(index, 1,
        { type: 'paragraph', content: [{ type: 'text', text: 'Intro paragraph' }] },
        ...codec.parse('with *emphasis* and **strong**.'))
      return next
    })
    expect(out).toContain('Intro paragraph\n\nwith *emphasis* and __strong__.')
    expect(out).toContain('* first item\n* second item\n    * nested item')
    expect(out).toContain('|:-----|-----:|')
  })

  it('inserts a new block between untouched ones with one blank line', () => {
    const out = edit(DOC, (nodes) => {
      const next = clone(nodes)
      const index = next.findIndex((node) => node.type === 'table')
      next.splice(index, 0, ...codec.parse('## New section'))
      return next
    })
    expect(out).toContain('    * nested item\n\n## New section\n\n| Name | Size |')
    expect(out.replace('## New section\n\n', '')).toBe(DOC)
  })

  it('deletes a block and keeps the blank lines of its neighbours', () => {
    const out = edit(DOC, (nodes) => nodes.filter((node) => node.type !== 'table'))
    expect(out).toContain('    * nested item\n\n- [ ] todo')
    expect(out).toContain('Intro paragraph with *emphasis* and __strong__.\n\n\n* first item')
  })

  it('keeps the frontmatter as written and lets it be edited on its own', () => {
    const fm = '---\ntitle: 新しい題\n---\n'
    const out = edit(DOC, (nodes) => nodes, fm)
    expect(out).toBe(DOC.replace('---\ntitle: 設計書\ntags: [a, b]\n---\n', fm))
    expect(splitFrontmatter('+++\na = 1\n+++\nbody').frontmatter).toBe('+++\na = 1\n+++\n')
  })

  it('keeps CRLF line endings', () => {
    const crlf = DOC.replace(/\n/g, '\r\n')
    expect(edit(crlf, (nodes) => nodes)).toBe(crlf)
    const out = edit(crlf, (nodes) => replaceText(nodes, 'second item', 'second'))
    expect(out).toBe(crlf.replace('* second item', '* second'))
    expect(out.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('keeps a file without a trailing newline without one', () => {
    const out = edit('# A\n\nlast line', (nodes) => replaceText(nodes, 'last', 'final'))
    expect(out).toBe('# A\n\nfinal line')
  })

  it('appends a paragraph at the end and keeps the trailing newline', () => {
    const out = edit('# A\n\ntext\n', (nodes) => [...nodes, ...codec.parse('more')])
    expect(out).toBe('# A\n\ntext\n\nmore\n')
  })

  // 崩れる範囲（正規形になる）を固定する
  it('rewrites only the edited block in canonical form when its own style cannot be kept', () => {
    // 別の記号のリストへ項目を移すような変更は、そのリストだけが「-」の書き方になる
    const source = '* a\n* b\n\nPara *x*\n'
    const out = edit(source, (nodes) => {
      const next = clone(nodes)
      next[0]!.content!.reverse()
      return next
    })
    expect(out).toBe('- b\n- a\n\nPara *x*\n')
  })

  it('keeps untouched blocks even when an edited block cannot be written back exactly (a line break in a table cell)', () => {
    const out = edit(DOC, (nodes) => {
      const next = clone(nodes)
      const walk = (node: JSONContent): boolean => {
        if (node.type === 'paragraph' && node.content?.[0]?.text === 'bb') {
          node.content.push({ type: 'hardBreak' }, { type: 'text', text: 'more' })
          return true
        }
        return (node.content ?? []).some(walk)
      }
      next.some(walk)
      return next
    })
    expect(out).toContain('Setext Title\n============')
    expect(out).toContain('* first item\n* second item\n    * nested item')
    expect(out).toContain('bb')
    expect(out).toContain('more')
  })

  it('writes raw HTML in an edited block as text (the preview never runs it)', () => {
    const source = 'Hello <b>bold</b>\n\n<div>block</div>\n'
    const out = edit(source, (nodes) => replaceText(nodes, 'Hello', 'Hi'))
    expect(out).toBe('Hi <b>bold</b>\n\n<div>block</div>\n')
  })

  it('reads back to the same document after every edit', () => {
    const changes = ['Intro', 'first item', 'nested item', 'Name', 'todo', 'one', 'graph', 'docs']
    for (const word of changes) {
      const model = buildSourceModel(DOC, codec)
      const edited = replaceText(model.nodes, word, `${word}X`)
      const out = reconcileMarkdown(model, edited, codec)
      expect(buildSourceModel(out, codec).nodes, word).toEqual(edited)
    }
  })

  it('falls back to the canonical text for a whole file it cannot map, and still keeps the content', () => {
    const big = `${'para\n\n'.repeat(5)}`
    const model = buildSourceModel(big, codec)
    const edited = replaceText(model.nodes, 'para', 'p')
    const out = reconcileMarkdown({ ...model, units: null }, edited, codec)
    expect(codec.parse(out)).toEqual(edited)
  })
})

describe('reconcileEdit (keystroke by keystroke)', () => {
  /** 1文字ずつ打ち、毎回直前の内容から作り直す（RichMarkdownEditor と同じ流れ） */
  function typeInto(source: string, word: string, typed: string): string {
    const saved = { text: source, model: buildSourceModel(source, codec) }
    let previous = saved.model
    let nodes = saved.model.nodes
    let text = source
    for (const char of typed) {
      const before = JSON.stringify(nodes)
      nodes = replaceText(nodes, word, word + char)
      expect(JSON.stringify(nodes)).not.toBe(before)
      word += char
      text = reconcileEdit(saved, previous, nodes, codec, saved.model.frontmatter)
      previous = buildSourceModel(text, codec)
    }
    // 途中（セルの末尾の空白など）は Markdown で表せないことがあるが、打ち終わりは同じ文書に戻る
    expect(previous.nodes).toEqual(nodes)
    return text
  }

  it('keeps the list marker even though a trailing space is typed on the way', () => {
    expect(typeInto(DOC, 'second item', ' (v2)')).toBe(DOC.replace('* second item', '* second item (v2)'))
  })

  it('keeps the table as written while a cell is typed into', () => {
    expect(typeInto(DOC, 'bb', ' x')).toBe(DOC.replace('| bb   |', '| bb x |'))
  })

  it('keeps the style of two neighbouring blocks edited one after the other', () => {
    const source = 'Intro *a*.\n\n* first\n* second\n'
    const saved = { text: source, model: buildSourceModel(source, codec) }
    let previous = saved.model
    let nodes = saved.model.nodes
    let text = source
    const step = (from: string, to: string) => {
      nodes = replaceText(nodes, from, to)
      text = reconcileEdit(saved, previous, nodes, codec, '')
      previous = buildSourceModel(text, codec)
    }
    step('Intro ', 'Intro, ')
    for (const [from, to] of [['second', 'second '], ['second ', 'second ('], ['second (', 'second (v2)']]) step(from!, to!)
    expect(text).toBe('Intro, *a*.\n\n* first\n* second (v2)\n')
  })

  it('returns the saved bytes when the document is back to the saved one', () => {
    const saved = { text: DOC, model: buildSourceModel(DOC, codec) }
    const edited = buildSourceModel(reconcileMarkdown(saved.model, replaceText(saved.model.nodes, 'Intro', 'Intro!'), codec), codec)
    expect(reconcileEdit(saved, edited, saved.model.nodes, codec, saved.model.frontmatter)).toBe(DOC)
  })
})

describe('patchSource', () => {
  it('applies a change found once in the source', () => {
    expect(patchSource('* one\n* two', '- one\n- two', '- one\n- 2')).toBe('* one\n* 2')
  })
  it('uses context when the changed text appears more than once', () => {
    expect(patchSource('a a a\nb', 'a a a\nb', 'a a a!\nb')).toBe('a a a!\nb')
  })
  it('gives up when the change cannot be located', () => {
    expect(patchSource('xyz', 'abc', 'abd')).toBeNull()
  })
})
