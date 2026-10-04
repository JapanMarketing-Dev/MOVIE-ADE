import { mkdir, mkdtemp, readdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import {
  MAX_MARKDOWN_MEDIA_BYTES, encodeMarkdownUrl, isMarkdownFilePath, markdownMediaKind, markdownMediaSnippet, parseVideoHtml, pickMediaFolder,
  relativeMediaPath, safeMediaFileName, sourceInsertion, uniqueMediaName, videoHtml
} from '@shared/markdownMedia'
import type { DroppedEntry } from '@shared/externalDrop'
import { embedMedia, planMediaDrop, planTreeMediaDrop, type MarkdownDropTarget, type MediaEmbed } from '../../src/renderer/editor/markdownDrop'
import { createMarkdownCodec } from '../../src/renderer/editor/richMarkdown/codec'
import { buildSourceModel, reconcileMarkdown } from '../../src/renderer/editor/richMarkdown/reconcile'
import { resolveRichImage } from '../../src/renderer/editor/richMarkdown/images'
import { importMediaForMarkdown } from '../../src/main/fileOps'

// 期待値は日本語の文言。画面の言語を日本語に固定する（既定は英語）
import { setLocale } from '@shared/i18n'
setLocale('ja')

/** Markdown へ画像・動画を落として埋め込む: 種類の判定、パス、書き方、振り分け、プレビューの往復、main のコピー */

describe('埋め込める種類（markdownMediaKind）', () => {
  it('画像と動画の拡張子だけ（大文字小文字は問わない）', () => {
    for (const name of ['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp', 'a.svg', 'a.avif']) expect(markdownMediaKind(name)).toBe('image')
    for (const name of ['a.mp4', 'b.WebM', 'dir/c.mov']) expect(markdownMediaKind(name)).toBe('video')
    for (const name of ['a.pdf', 'a.mp3', 'a.html', 'a.exe', 'png', '.png', 'a.png.txt', 'C:\\x\\a.txt']) expect(markdownMediaKind(name)).toBeNull()
    expect(markdownMediaKind('C:\\Users\\a\\Desktop\\shot.PNG')).toBe('image')
  })

  it('埋め込み先にできる Markdown のファイル', () => {
    expect(isMarkdownFilePath('docs/a.md')).toBe(true)
    expect(isMarkdownFilePath('a.markdown')).toBe(true)
    expect(isMarkdownFilePath('a.MDX')).toBe(true)
    expect(isMarkdownFilePath('a.txt')).toBe(false)
    expect(isMarkdownFilePath('a.md.png')).toBe(false)
  })
})

describe('コピー先のフォルダ（pickMediaFolder）', () => {
  it('隣に既にある assets / images / media / img を使う（この順）', () => {
    expect(pickMediaFolder(['src', 'images'])).toBe('images')
    expect(pickMediaFolder(['img', 'media'])).toBe('media')
    expect(pickMediaFolder(['images', 'assets'])).toBe('assets')
  })
  it('無ければ assets。同じ名前のファイルがあれば次の候補', () => {
    expect(pickMediaFolder([])).toBe('assets')
    expect(pickMediaFolder([], ['assets', 'README.md'])).toBe('images')
    expect(pickMediaFolder([], ['Assets', 'images', 'media', 'img'])).toBeNull()
  })
})

describe('コピーする名前（safeMediaFileName / uniqueMediaName）', () => {
  it('空白（macOS の狭い空白も）は - に、リンクで困る記号は除き、拡張子は小文字', () => {
    expect(safeMediaFileName('Screenshot 2026-10-04 at 9.41.00\u202fAM.PNG')).toBe('Screenshot-2026-10-04-at-9.41.00-AM.png')
    expect(safeMediaFileName('スクリーンショット　最終 (1).png')).toBe('スクリーンショット-最終-1.png')
    expect(safeMediaFileName('a#b?c%d[e]<f>.gif')).toBe('abcdef.gif')
    expect(safeMediaFileName('/Users/taro/Desktop/demo.mov')).toBe('demo.mov')
    expect(safeMediaFileName('C:\\Users\\a\\clip.MP4')).toBe('clip.mp4')
  })
  it('名前が残らなければ media', () => {
    expect(safeMediaFileName('().png')).toBe('media.png')
    expect(safeMediaFileName('---.webp')).toBe('media.webp')
  })
  it('重なれば -2, -3（大文字小文字は区別しない）', () => {
    expect(uniqueMediaName('a.png', [])).toBe('a.png')
    expect(uniqueMediaName('a.png', ['A.PNG'])).toBe('a-2.png')
    expect(uniqueMediaName('a.png', ['a.png', 'a-2.png'])).toBe('a-3.png')
    expect(uniqueMediaName('clip', ['clip'])).toBe('clip-2')
  })
})

describe('Markdown からの相対パス（relativeMediaPath）', () => {
  it('同じフォルダ・下・上・根', () => {
    expect(relativeMediaPath('docs/guide.md', 'docs/assets/a.png')).toBe('assets/a.png')
    expect(relativeMediaPath('docs/guide.md', 'docs/a.png')).toBe('a.png')
    expect(relativeMediaPath('docs/deep/guide.md', 'images/a.png')).toBe('../../images/a.png')
    expect(relativeMediaPath('docs/guide.md', 'docs-old/a.png')).toBe('../docs-old/a.png')
    expect(relativeMediaPath('README.md', 'assets/a.png')).toBe('assets/a.png')
    expect(relativeMediaPath('README.md', 'a.png')).toBe('a.png')
  })
  it('同じ名前のフォルダとファイルを取り違えない', () => {
    expect(relativeMediaPath('a/b.md', 'a')).toBe('../a')
    expect(relativeMediaPath('a/b/c.md', 'a/b')).toBe('../b')
  })
})

describe('書き方（markdownMediaSnippet / sourceInsertion）', () => {
  it('画像は ![名前](パス)、動画は <video src controls>', () => {
    expect(markdownMediaSnippet('image', 'assets/shot.png')).toBe('![shot](assets/shot.png)')
    expect(markdownMediaSnippet('video', '../media/demo.mp4')).toBe('<video src="../media/demo.mp4" controls></video>')
  })
  it('空白・括弧・% は符号化し、日本語と / はそのまま。alt の [ ] は逃がす', () => {
    expect(encodeMarkdownUrl('my shots/a (1)%.png')).toBe('my%20shots/a%20%281%29%25.png')
    expect(markdownMediaSnippet('image', '画像/[draft] 1.png')).toBe('![\\[draft\\] 1](画像/%5Bdraft%5D%201.png)')
    expect(markdownMediaSnippet('video', 'a"b.mp4')).toBe('<video src="a%22b.mp4" controls></video>')
  })
  it('符号化したパスはプレビューで元のファイルに戻る', () => {
    const resolved = resolveRichImage(encodeMarkdownUrl('my shots/a (1).png'), 'docs/guide.md')
    expect(resolved).toEqual({ kind: 'local', url: 'ade-media://project/docs/my%20shots/a%20(1).png' })
    expect(resolveRichImage('assets/demo.mp4', 'docs/guide.md')).toEqual({ kind: 'local', url: 'ade-media://project/docs/assets/demo.mp4' })
  })
  it('カーソルの前後に文字があれば空行で区切り、塊ごとに段落にする', () => {
    expect(sourceInsertion(['![a](a.png)'], '', '')).toBe('![a](a.png)')
    expect(sourceInsertion(['![a](a.png)', '<video src="b.mp4" controls></video>'], 'text ', '')).toBe('\n\n![a](a.png)\n\n<video src="b.mp4" controls></video>')
    expect(sourceInsertion(['![a](a.png)'], '', 'rest')).toBe('![a](a.png)\n\n')
    expect(sourceInsertion([], 'x', 'y')).toBe('')
  })
  it('動画の HTML を読む（書いた形と、引用符違い）。src の無いもの・中身のあるものは読まない', () => {
    expect(parseVideoHtml(videoHtml('a&b.mp4'))).toEqual({ src: 'a&b.mp4' })
    expect(parseVideoHtml("<video src='x.webm' controls></video>")).toEqual({ src: 'x.webm' })
    expect(parseVideoHtml('<video controls></video>')).toBeNull()
    expect(parseVideoHtml('<video src="x.mp4">fallback</video>')).toBeNull()
    expect(parseVideoHtml('<img src="x.png">')).toBeNull()
  })
})

describe('落としたものの振り分け（planMediaDrop / planTreeMediaDrop / embedMedia）', () => {
  const entries: DroppedEntry[] = [
    { path: '/p/docs/a.png', kind: 'file', relPath: 'docs/a.png' },
    { path: '/Users/taro/Desktop/clip.mov', kind: 'file', relPath: null },
    { path: '/p/notes.txt', kind: 'file', relPath: 'notes.txt' },
    { path: '/Users/taro/Desktop/pics', kind: 'dir', relPath: null },
    { path: '/Users/taro/Desktop/b.webp', kind: 'file', relPath: null }
  ]

  it('画像・動画は埋め込みへ（中は相対パス、外は絶対パス）、それ以外は今までどおり', () => {
    const plan = planMediaDrop(entries)
    expect(plan.media).toEqual([
      { kind: 'image', relPath: 'docs/a.png' },
      { kind: 'video', outsidePath: '/Users/taro/Desktop/clip.mov' },
      { kind: 'image', outsidePath: '/Users/taro/Desktop/b.webp' }
    ])
    expect(plan.rest.map((e) => e.path)).toEqual(['/p/notes.txt', '/Users/taro/Desktop/pics'])
  })

  it('ファイルツリーから: 画像・動画だけを埋め込みへ', () => {
    expect(planTreeMediaDrop(['img/a.png', 'src/a.ts', 'v.webm'])).toEqual({
      media: [{ kind: 'image', relPath: 'img/a.png' }, { kind: 'video', relPath: 'v.webm' }],
      rest: ['src/a.ts']
    })
  })

  it('外のものはコピーしてから、どれも Markdown からの相対パスで、落とした順に入れる', async () => {
    const inserted: MediaEmbed[][] = []
    const target: MarkdownDropTarget = { path: 'docs/guide.md', element: () => null, insert: (media) => { inserted.push([...media]) } }
    const calls: Array<[string, string[]]> = []
    await embedMedia(target, planMediaDrop(entries).media, { x: 1, y: 1 }, async (md, paths) => {
      calls.push([md, paths])
      return ['docs/assets/clip.mov', 'docs/assets/b.webp']
    })
    expect(calls).toEqual([['docs/guide.md', ['/Users/taro/Desktop/clip.mov', '/Users/taro/Desktop/b.webp']]])
    expect(inserted).toEqual([[
      { kind: 'image', link: 'a.png' },
      { kind: 'video', link: 'assets/clip.mov' },
      { kind: 'image', link: 'assets/b.webp' }
    ]])
  })

  it('中のものだけならコピーしない。コピーに失敗したら何も入れない', async () => {
    const inserted: MediaEmbed[][] = []
    const target: MarkdownDropTarget = { path: 'README.md', element: () => null, insert: (media) => { inserted.push([...media]) } }
    let copied = false
    await embedMedia(target, [{ kind: 'image', relPath: 'docs/images/a.png' }], { x: 0, y: 0 }, async () => { copied = true; return [] })
    expect(copied).toBe(false)
    expect(inserted).toEqual([[{ kind: 'image', link: 'docs/images/a.png' }]])
    await expect(embedMedia(target, [{ kind: 'video', outsidePath: '/x/a.mp4' }], { x: 0, y: 0 }, async () => { throw new Error('too large') })).rejects.toThrow('too large')
    expect(inserted).toHaveLength(1)
  })
})

describe('プレビューでの動画（codec の Video）', () => {
  const codec = createMarkdownCodec()

  it('1行の <video src controls> は動画の塊として読み、同じ形で書き戻す', () => {
    const md = 'Intro\n\n<video src="assets/a%20b.mp4" controls></video>\n\nAfter\n'
    expect(codec.lex(md).map((x) => x.type)).toEqual(['paragraph', 'space', 'video', 'space', 'paragraph'])
    const nodes = codec.parse(md)
    expect(nodes[1]).toEqual({ type: 'video', attrs: { src: 'assets/a%20b.mp4' } })
    expect(codec.serialize(nodes)).toBe('Intro\n\n<video src="assets/a%20b.mp4" controls></video>\n\nAfter')
  })

  it('ほかの属性を付けた video・行の途中の <video は文字のまま（属性を落とさない）', () => {
    const nodes = codec.parse('<video src="a.mp4" controls autoplay></video>\n\nsee <video src="b.mp4" controls></video>\n')
    expect(nodes.map((n) => n.type)).toEqual(['paragraph', 'paragraph'])
    expect(JSON.stringify(nodes)).not.toContain('"type":"video"')
  })

  it('プレビューで動画と画像を足しても、ほかの部分は元の書き方のまま', () => {
    const source = '# Title\n\n* one\n* two\n\nText\n'
    const model = buildSourceModel(source, codec)
    const edited: JSONContent[] = [
      ...model.nodes.slice(0, 2),
      { type: 'video', attrs: { src: 'assets/demo.mp4' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'Text ' }, { type: 'image', attrs: { src: 'assets/shot.png', alt: 'shot', title: null, width: null, height: null } }] }
    ]
    const out = reconcileMarkdown(model, edited, codec)
    expect(out).toBe('# Title\n\n* one\n* two\n\n<video src="assets/demo.mp4" controls></video>\n\nText ![shot](assets/shot.png)\n')
  })
})

describe('importMediaForMarkdown（外から落とした画像・動画を Markdown の隣へコピー）', () => {
  let base: string
  let root: string
  let dropped: string
  let outside: string
  const allow = (path: unknown) => typeof path === 'string' && path.startsWith(dropped)

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ade-mdmedia-'))
    root = join(base, 'project')
    dropped = join(base, 'Desktop')
    outside = join(base, 'outside')
    await mkdir(join(root, 'docs'), { recursive: true })
    await mkdir(join(root, '.git'))
    await mkdir(dropped)
    await mkdir(outside)
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n')
    await writeFile(join(root, 'README.md'), '# hi\n')
    await writeFile(join(root, 'docs', 'notes.txt'), 'x')
    await writeFile(join(dropped, 'Screen Shot 1.png'), 'png')
    await writeFile(join(dropped, 'demo.MOV'), 'mov')
    await writeFile(join(dropped, 'tool.exe'), 'exe')
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('assets/ を作ってコピーし、リンクに書ける名前で、渡した順に相対パスを返す。元はそのまま', async () => {
    await expect(importMediaForMarkdown(root, 'docs/guide.md', [join(dropped, 'Screen Shot 1.png'), join(dropped, 'demo.MOV')], allow))
      .resolves.toEqual(['docs/assets/Screen-Shot-1.png', 'docs/assets/demo.mov'])
    expect(await readFile(join(root, 'docs', 'assets', 'Screen-Shot-1.png'), 'utf8')).toBe('png')
    expect(await readFile(join(dropped, 'demo.MOV'), 'utf8')).toBe('mov')
  })

  it('隣に images/ があればそれを使い、同じ名前があれば -2 にする（上書きしない）', async () => {
    await mkdir(join(root, 'images'))
    await writeFile(join(root, 'images', 'Screen-Shot-1.png'), 'mine')
    await expect(importMediaForMarkdown(root, 'README.md', [join(dropped, 'Screen Shot 1.png')], allow)).resolves.toEqual(['images/Screen-Shot-1-2.png'])
    expect(await readFile(join(root, 'images', 'Screen-Shot-1.png'), 'utf8')).toBe('mine')
    expect(existsSync(join(root, 'assets'))).toBe(false)
  })

  it('画像・動画でないもの・フォルダ・リンクは断る', async () => {
    await expect(importMediaForMarkdown(root, 'docs/guide.md', [join(dropped, 'tool.exe')], allow)).rejects.toThrow('埋め込めません')
    await mkdir(join(dropped, 'pics.png'))
    await expect(importMediaForMarkdown(root, 'docs/guide.md', [join(dropped, 'pics.png')], allow)).rejects.toThrow('埋め込めません')
    await writeFile(join(outside, 'secret.png'), 'secret')
    await symlink(join(outside, 'secret.png'), join(dropped, 'link.png'))
    await expect(importMediaForMarkdown(root, 'docs/guide.md', [join(dropped, 'link.png')], allow)).rejects.toThrow('埋め込めません')
    expect(existsSync(join(root, 'docs', 'assets'))).toBe(false)
  })

  it('種類ごとの上限を超えるものは断る（1つでもあれば何もコピーしない）', async () => {
    await writeFile(join(dropped, 'huge.png'), '')
    await truncate(join(dropped, 'huge.png'), MAX_MARKDOWN_MEDIA_BYTES.image + 1)
    await expect(importMediaForMarkdown(root, 'docs/guide.md', [join(dropped, 'demo.MOV'), join(dropped, 'huge.png')], allow)).rejects.toThrow('大きすぎて')
    expect(existsSync(join(root, 'docs', 'assets'))).toBe(false)
  })

  it('落とされていないパス・相対パス・空・多すぎる指定は読まない', async () => {
    await writeFile(join(outside, 'secret.png'), 'secret')
    await expect(importMediaForMarkdown(root, 'docs/guide.md', [join(outside, 'secret.png')], allow)).rejects.toThrow()
    await expect(importMediaForMarkdown(root, 'docs/guide.md', [join(outside, 'secret.png')])).rejects.toThrow()
    await expect(importMediaForMarkdown(root, 'docs/guide.md', ['a.png'], () => true)).rejects.toThrow()
    await expect(importMediaForMarkdown(root, 'docs/guide.md', [], allow)).rejects.toThrow()
    await expect(importMediaForMarkdown(root, 'docs/guide.md', Array(51).fill(join(dropped, 'demo.MOV')), allow)).rejects.toThrow()
    await expect(importMediaForMarkdown(root, 'docs/guide.md', 'x', allow)).rejects.toThrow()
  })

  it('Markdown でないファイル・プロジェクトの外・.git の中・無いファイルを先にしない', async () => {
    const src = [join(dropped, 'demo.MOV')]
    await expect(importMediaForMarkdown(root, 'docs/notes.txt', src, allow)).rejects.toThrow()
    await expect(importMediaForMarkdown(root, '../outside/a.md', src, allow)).rejects.toThrow()
    await expect(importMediaForMarkdown(root, join(outside, 'a.md'), src, allow)).rejects.toThrow()
    await writeFile(join(root, '.git', 'x.md'), '')
    await expect(importMediaForMarkdown(root, '.git/x.md', src, allow)).rejects.toThrow('.git の中')
    await expect(importMediaForMarkdown(root, 'docs/missing.md', src, allow)).rejects.toThrow()
    await expect(importMediaForMarkdown(root, 'docs', src, allow)).rejects.toThrow()
    expect(await readdir(outside)).toEqual([])
  })

  it('隣の assets が外を指すリンクなら、そこへは書かずに次の候補（images）を作る', async () => {
    await symlink(outside, join(root, 'docs', 'assets'))
    await expect(importMediaForMarkdown(root, 'docs/guide.md', [join(dropped, 'demo.MOV')], allow)).resolves.toEqual(['docs/images/demo.mov'])
    expect(await readdir(outside)).toEqual([])
  })

  it('候補がどれも外を指すリンクなら断る（外には書かない）', async () => {
    for (const name of ['assets', 'images', 'media', 'img']) await symlink(outside, join(root, 'docs', name))
    await expect(importMediaForMarkdown(root, 'docs/guide.md', [join(dropped, 'demo.MOV')], allow)).rejects.toThrow()
    expect(await readdir(outside)).toEqual([])
  })
})
