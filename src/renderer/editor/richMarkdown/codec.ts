import { getSchema, mergeAttributes, type AnyExtension, type JSONContent } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import CodeBlock from '@tiptap/extension-code-block'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import Image from '@tiptap/extension-image'

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

/** 編集と変換で共通の拡張。image には表示（nodeView）を足したものを渡せる（スキーマは変えないこと） */
export function richMarkdownExtensions(image: typeof Image = Image): AnyExtension[] {
  return [
    StarterKit.configure({
      codeBlock: false,
      // 末尾に空の段落を足さない（足すと開いただけで内容が変わる）
      trailingNode: false,
      link: { openOnClick: false, autolink: false, linkOnPaste: true }
    }),
    LabeledCodeBlock,
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // 段落の中の画像（![a](b)）をそのまま段落に置く
    image.configure({ inline: true, allowBase64: true })
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
