import { Node, getSchema, mergeAttributes, type AnyExtension, type JSONContent } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import CodeBlock from '@tiptap/extension-code-block'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import Image from '@tiptap/extension-image'
import { parseVideoHtml, videoHtml } from '@shared/markdownMedia'

/**
 * プレビューで編集するときの Markdown ⇄ 文書（TipTap / ProseMirror の JSON）の変換。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/editor/rich-markdown-extensions.ts（MIT）
 *   TipTap 3 の StarterKit・表・チェックボックス・画像と @tiptap/markdown で往復する。
 *   「プレビューで編集できる」と判定する変換と、編集に使う拡張は同じ一式にする（ずれると保存で記法を失う）。
 * DOM を使わないので単体テストからも使う（画像の表示は RichMarkdownEditor が nodeView を足す）。
 */

/** コードブロック。言語（mermaid など）を pre の data-language に出し、見出しのように表示する */
export const LabeledCodeBlock = CodeBlock.extend({
  renderHTML({ node, HTMLAttributes }) {
    const language = typeof node.attrs.language === 'string' ? node.attrs.language : ''
    return [
      'pre',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, language ? { 'data-language': language } : {}),
      ['code', { class: language ? `${this.options.languageClassPrefix}${language}` : null }, 0]
    ]
  }
})

/** 1行だけの <video src="…" controls></video>（前後の空行まで含めない） */
const VIDEO_LINE_RE = /^ {0,3}(<video\b[^>\n]*>[ \t]*<\/video>)[ \t]*(?=\n|$)/i

/**
 * 動画の埋め込み（<video src="パス" controls></video> の1行）。生の HTML は文字として出すが、これだけは動画の塊として読み、
 * 同じ形で書き戻す（src は Markdown のファイルからの相対パス。表示は RichMarkdownEditor が nodeView を足す）。
 * 属性は src だけを持つ（それ以外の属性を付けた video は、ほかの HTML と同じく文字のまま）
 */
export const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { src: { default: null } }
  },
  parseHTML() {
    return [{ tag: 'video[src]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['video', mergeAttributes(HTMLAttributes, { controls: 'true' })]
  },
  markdownTokenizer: {
    name: 'video',
    level: 'block',
    // 行の頭の <video だけ（行の途中の文字で段落を切らない）
    start: (src: string) => {
      const match = /(?:^|\n)( {0,3}<video\b)/i.exec(src)
      return match ? match.index + match[0].length - match[1]!.length : -1
    },
    tokenize: (src: string) => {
      const match = VIDEO_LINE_RE.exec(src)
      if (!match) return undefined
      const video = parseVideoHtml(match[1]!)
      // 書き戻すと同じ形になるものだけ（違う属性を落とさない）
      if (!video || videoHtml(video.src).toLowerCase() !== match[1]!.trim().toLowerCase()) return undefined
      return { type: 'video', raw: match[0], src: video.src }
    }
  },
  parseMarkdown: (token, helpers) => helpers.createNode('video', { src: (token as { src?: string }).src ?? null }),
  renderMarkdown: (node) => videoHtml(typeof node.attrs?.src === 'string' ? node.attrs.src : '')
})

/** 編集と変換で共通の拡張。image・video・codeBlock には表示（nodeView）を足したものを渡せる（スキーマは変えないこと） */
export function richMarkdownExtensions(image: typeof Image = Image, video: typeof Video = Video, codeBlock: typeof LabeledCodeBlock = LabeledCodeBlock): AnyExtension[] {
  return [
    StarterKit.configure({
      codeBlock: false,
      // 末尾に空の段落を足さない（足すと開いただけで内容が変わる）
      trailingNode: false,
      link: { openOnClick: false, autolink: false, linkOnPaste: true }
    }),
    codeBlock,
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // 段落の中の画像（![a](b)）をそのまま段落に置く
    image.configure({ inline: true, allowBase64: true }),
    video
  ]
}

/** reconcile.ts が使う変換。JSON は最上位の塊（doc の content）の並び */
export interface MarkdownCodec {
  /** Markdown → 最上位の塊。スキーマで正規化する（属性の既定値を埋めて、編集中の文書と比べられる形にする） */
  parse: (markdown: string) => JSONContent[]
  /** 最上位の塊 → Markdown（@tiptap/markdown の書き方） */
  serialize: (nodes: JSONContent[]) => string
  /** 最上位の塊ごとの元の文字列（marked の字句解析。type と raw） */
  lex: (markdown: string) => { type: string; raw: string }[]
}

export function createMarkdownCodec(extensions: AnyExtension[] = richMarkdownExtensions()): MarkdownCodec & { schema: Schema } {
  const manager = new MarkdownManager({ extensions })
  const schema = getSchema(extensions)
  const normalize = (doc: JSONContent): JSONContent[] => {
    try {
      return (schema.nodeFromJSON(doc).toJSON() as JSONContent).content ?? []
    } catch {
      // スキーマに合わない形（ほぼ無い）は、そのまま返す。比べると食い違うので、元の文字列は使われない
      return doc.content ?? []
    }
  }
  return {
    schema,
    parse: (markdown) => normalize(manager.parse(markdown)),
    serialize: (nodes) => (nodes.length === 0 ? '' : manager.serialize({ type: 'doc', content: nodes })),
    lex: (markdown) => manager.instance.lexer(markdown).map((token) => ({ type: token.type, raw: token.raw }))
  }
}
