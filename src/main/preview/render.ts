import { Marked } from 'marked'
import { isMermaidFence, type PreviewKind } from '@shared/preview'

/** ページの種類。md / Mermaid 以外のテキストは、読み取り専用のコードとして出す（レビューの対象にするため） */
export type PreviewPageKind = PreviewKind | 'code'
import { getLocale, t } from '@shared/i18n'

/**
 * プレビューのページの HTML を組み立てる（純粋関数。electron を読まない）。
 *
 * Orca は react-markdown と remark / rehype で描く（~/bench/orca/src/renderer/src/components/editor/
 * markdown-preview-document-engine.ts ほか、MIT）。ここは内蔵ブラウザへ渡す静的なページなので、
 * main で marked を使って HTML にし、```mermaid のブロックだけ <pre class="mermaid"> にして
 * ページ側（page.js）で Mermaid に描かせる。
 * 生の HTML は文字として出す（Agent が書いたファイルのスクリプトをレビュー対象のページで動かさない）。
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function mermaidBlock(source: string): string {
  return `<pre class="mermaid">${escapeHtml(source)}</pre>\n`
}

const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text)
    },
    code({ text, lang }) {
      // false を返すと marked の既定の描き方（<pre><code>）になる
      return isMermaidFence(lang) ? mermaidBlock(text) : false
    }
  }
})

/** 描いた塊の最初のタグに、元の行（1始まり）を付ける。プレビューからエディタの該当行へ飛ぶのに使う */
function withSourceLine(html: string, line: number): string {
  return html.replace(/^(\s*<[a-z][a-z0-9]*)/i, `$1 data-line="${line}"`)
}

/**
 * ページの中身（<main> の内側）。保存・編集のたびに、これだけを作り直して差し替える。
 * 最上位の塊（見出し・段落・リスト・表・コード・図）ごとに描き、それぞれに data-line を付ける。
 */
export function renderPreviewBody(kind: PreviewPageKind, source: string): string {
  if (kind === 'mermaid') return withSourceLine(mermaidBlock(source), 1)
  if (kind === 'code') return `<pre class="code-view" data-line="1"><code>${escapeHtml(source)}</code></pre>\n`
  const tokens = marked.lexer(source)
  let line = 1
  let html = ''
  for (const token of tokens) {
    // 参照リンク（[a]: url）の定義は文書全体で共有する
    const part = marked.parser(Object.assign([token], { links: tokens.links }))
    html += token.type === 'space' ? part : withSourceLine(part, line)
    line += token.raw.split('\n').length - 1
  }
  return html
}

/** 開けないファイル（バイナリ・大きすぎる・読めない）のときの中身 */
export function renderPreviewMessage(message: string): string {
  return `<p class="mermaid-error">${escapeHtml(message)}</p>\n`
}

/**
 * プレビューのページ全体。スタイルとスクリプトは同梱のもの（ade-preview://assets/…）だけを読む。
 * Mermaid（5MB 強）は図があるときだけ page.js が読み込む。
 */
export function renderPreviewPage({ path, kind, body }: { path: string; kind: PreviewPageKind; body: string }): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  // page.js は辞書を読めないので、ページで出す文は data 属性で渡す（言語はページを返した時点のもの）
  const messages = `data-msg-mermaid-load="${escapeHtml(t('preview.mermaidLoadFailed'))}" data-msg-diagram-failed="${escapeHtml(t('preview.diagramFailed', { error: '{{error}}' }))}"`
  return `<!doctype html>
<html lang="${getLocale()}">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(name)}</title>
<link rel="stylesheet" href="ade-preview://assets/preview.css">
</head>
<body>
<main id="ade-preview" class="markdown-body${kind === 'mermaid' ? ' markdown-body--diagram' : ''}" data-path="${escapeHtml(path)}" ${messages}>
${body}</main>
<script src="ade-preview://assets/preview.js"></script>
</body>
</html>
`
}
