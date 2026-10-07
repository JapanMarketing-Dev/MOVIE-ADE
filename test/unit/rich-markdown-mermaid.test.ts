import { describe, expect, it } from 'vitest'
import { createMarkdownCodec } from '../../src/renderer/editor/richMarkdown/codec'
import { buildSourceModel, reconcileMarkdown } from '../../src/renderer/editor/richMarkdown/reconcile'
import { diagramKey, isMermaidLanguage, modeForSelection, svgDataUrl } from '../../src/renderer/editor/richMarkdown/mermaidBlock'
import { mermaidScriptUrl, previewCsp, renderMermaidBlockPage, renderPreviewPage } from '../../src/main/preview/render'

const DOC = '# 構成\n\n```mermaid\nflowchart TB\n  U[利用者] -->|HTTPS| W\n  W --> DB\n```\n\n本文\n'

describe('Markdown の編集画面の ```mermaid を図で出す（表示だけ。保存する Markdown は変えない）', () => {
  it('mermaid / mmd だけを図にする', () => {
    expect(isMermaidLanguage('mermaid')).toBe(true)
    expect(isMermaidLanguage('mmd')).toBe(true)
    expect(isMermaidLanguage('Mermaid')).toBe(true)
    for (const language of ['ts', '', null, undefined, 'mermaid-ish']) expect(isMermaidLanguage(language), String(language)).toBe(false)
  })

  it('```mermaid のソースは往復で変わらない（言語もそのまま）', () => {
    const codec = createMarkdownCodec()
    const nodes = codec.parse(DOC)
    const block = nodes.find((node) => node.type === 'codeBlock')
    expect(block?.attrs?.language).toBe('mermaid')
    expect(block?.content?.[0]?.text).toBe('flowchart TB\n  U[利用者] -->|HTTPS| W\n  W --> DB')
    // 変えていない文書は元の文字列のまま戻る
    expect(reconcileMarkdown(buildSourceModel(DOC, codec), nodes, codec)).toBe(DOC)
  })

  it('カーソルが中に入ったらコード、外へ出たら図。「コード」で開いた直後（まだ中に入っていない）はコードのまま', () => {
    expect(modeForSelection('diagram', true, false)).toBe('code')
    expect(modeForSelection('code', false, true)).toBe('diagram')
    expect(modeForSelection('code', false, false)).toBe('code')
    expect(modeForSelection('diagram', false, false)).toBe('diagram')
  })

  it('図は SVG の画像（data: の URL）で出す。文字は符号化して URL の外に出さない', () => {
    const url = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><text>"a" & <b></text></svg>')
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(url).not.toMatch(/[<>"]/)
  })

  it('描いた図の鍵はソースと配色で変わる', () => {
    expect(diagramKey('a', 'dark')).toBe(diagramKey('a', 'dark'))
    expect(diagramKey('a', 'dark')).not.toBe(diagramKey('a', 'light'))
    expect(diagramKey('a', 'dark')).not.toBe(diagramKey('b', 'dark'))
  })

  it('図だけのページは同梱のスクリプトだけを読み、インラインのスクリプトを持たない（プレビューの CSP のまま）', () => {
    const page = renderMermaidBlockPage()
    expect(page).toContain('<script src="ade-preview://assets/mermaid-block.js"></script>')
    expect(page.match(/<script\b/g)).toHaveLength(1)
    expect(page).not.toMatch(/\son[a-z]+=/i)
    expect(previewCsp()).toMatch(/script-src ade-preview:(;|$)/)
  })

  it('同梱の Mermaid は版付きの URL で読む（版が変われば URL も変わる）', () => {
    expect(mermaidScriptUrl()).toBe('ade-preview://assets/mermaid.js')
    expect(mermaidScriptUrl('0.4.20')).toBe('ade-preview://assets/mermaid.js?v=0.4.20')
    expect(renderMermaidBlockPage(mermaidScriptUrl('0.4.20'))).toContain('data-mermaid-src="ade-preview://assets/mermaid.js?v=0.4.20"')
    expect(renderPreviewPage({ path: 'a.md', kind: 'markdown', body: '', mermaidSrc: mermaidScriptUrl('0.4.20') })).toContain('data-mermaid-src="ade-preview://assets/mermaid.js?v=0.4.20"')
  })
})
