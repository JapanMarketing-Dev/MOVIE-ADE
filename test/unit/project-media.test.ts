import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BINARY_HEAD_BYTES, formatByteSize, formatHexDump, isRiskyToOpenExternally, isSvgPath, mediaKindOf, mediaTypeOf,
  projectMediaPathFromUrl, projectMediaUrl
} from '@shared/fileViewer'
import { inspectProjectFile, projectMediaResponse } from '../../src/main/projectMedia'

describe('ビューアの種類と URL（@shared/fileViewer）', () => {
  it('拡張子から画像・動画・音声・PDF を選ぶ（大文字も）', () => {
    expect(mediaKindOf('a/b.PNG')).toBe('image')
    expect(mediaKindOf('logo.svg')).toBe('image')
    expect(mediaKindOf('icon.avif')).toBe('image')
    expect(mediaKindOf('clip.mov')).toBe('video')
    expect(mediaKindOf('clip.m4v')).toBe('video')
    expect(mediaKindOf('voice.m4a')).toBe('audio')
    expect(mediaKindOf('doc.pdf')).toBe('pdf')
    expect(mediaTypeOf('x.webm')).toEqual({ kind: 'video', type: 'video/webm' })
  })

  it('テキストや実行されうるものは中身を返す対象にしない', () => {
    for (const path of ['index.html', 'a.js', 'Makefile', '.png', 'dir.png/file', 'a.zip']) expect(mediaKindOf(path)).toBeNull()
    expect(isSvgPath('a/LOGO.SVG')).toBe(true)
  })

  it('URL と相対パスを行き来できる（日本語・空白・# ? を含む）', () => {
    const path = 'assets/画 像/a #1?.png'
    const url = projectMediaUrl(path)
    expect(url.startsWith('ade-media://project/assets/')).toBe(true)
    expect(projectMediaPathFromUrl(url)).toBe(path)
    expect(projectMediaPathFromUrl(projectMediaUrl(path, 3))).toBe(path)
    expect(projectMediaUrl('a.png', 2)).toBe('ade-media://project/a.png?v=2')
  })

  it('外へ出る形・違うホスト・壊れた符号は null', () => {
    // URL の解釈で `..` は根の中に畳まれる（外へは出ない）
    expect(projectMediaPathFromUrl('ade-media://project/%2E%2E/secret.png')).toBe('secret.png')
    expect(projectMediaPathFromUrl('ade-media://project/a/%2e%2e/%2e%2e/b.png')).toBe('b.png')
    expect(projectMediaPathFromUrl('ade-media://project/..%2Fsecret.png')).toBeNull()
    expect(projectMediaPathFromUrl('ade-media://project/..%5Csecret.png')).toBeNull()
    expect(projectMediaPathFromUrl('ade-media://project/a%00.png')).toBeNull()
    expect(projectMediaPathFromUrl('ade-media://project/a//b.png')).toBeNull()
    expect(projectMediaPathFromUrl('ade-media://project/%E0%A4%A.png')).toBeNull()
    expect(projectMediaPathFromUrl('ade-media://review/a.png')).toBeNull()
    expect(projectMediaPathFromUrl('ade-preview://project/a.png')).toBeNull()
    expect(projectMediaPathFromUrl('not a url')).toBeNull()
    expect(projectMediaPathFromUrl('ade-media://project/')).toBeNull()
  })

  it('OS で開くと実行されうるものを見分ける', () => {
    for (const path of ['run.command', 'Tool.app', 'setup.EXE', 'x.sh', 'build', 'page.html', 'a.svg', 'b.jar']) expect(isRiskyToOpenExternally(path)).toBe(true)
    for (const path of ['a.png', 'b.pdf', 'c.mp4', 'd.zip', 'e.sqlite']) expect(isRiskyToOpenExternally(path)).toBe(false)
  })

  it('16進数の表示（オフセット・2つに分けた16バイト・読める文字）', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x41, 0x42, 0x7f, 0x20, 0x7e, 0xff, 0x30, 0x31])
    const lines = formatHexDump(bytes)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('00000000  89 50 4e 47 0d 0a 1a 0a  00 41 42 7f 20 7e ff 30  |.PNG.....AB. ~.0|')
    expect(lines[1]).toBe(`00000010  31${' '.repeat(21)}  ${' '.repeat(23)}  |1|`)
    expect(formatHexDump(new Uint8Array(0))).toEqual([])
    expect(formatHexDump(new Uint8Array([1]), 0x100)[0]!.startsWith('00000100')).toBe(true)
  })

  it('大きさの表示', () => {
    expect(formatByteSize(0)).toBe('0 B')
    expect(formatByteSize(1023)).toBe('1023 B')
    expect(formatByteSize(1536)).toBe('1.5 KB')
    expect(formatByteSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatByteSize(300 * 1024 * 1024)).toBe('300 MB')
    expect(formatByteSize(-1)).toBe('-')
  })
})

describe('プロジェクトのファイルの中身を返す（ade-media://project/）', () => {
  let base: string
  let root: string

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'ferret-project-media-'))
    root = join(base, 'acme-shop')
    await mkdir(join(root, 'assets'), { recursive: true })
    await mkdir(join(base, 'outside'), { recursive: true })
    await writeFile(join(root, 'assets', 'clip.mp4'), Buffer.from('0123456789'))
    await writeFile(join(root, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    await writeFile(join(root, 'index.html'), '<script>alert(1)</script>')
    await writeFile(join(root, 'blob.bin'), Buffer.alloc(BINARY_HEAD_BYTES + 100, 7))
    await writeFile(join(base, 'outside', 'secret.png'), Buffer.from('secret'))
    await symlink(join(base, 'outside', 'secret.png'), join(root, 'leak.png'))
    await mkdir(join(root, 'folder.png'))
    if (process.platform !== 'win32') execFileSync('mkfifo', [join(root, 'pipe.mp4')])
  })

  afterAll(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('Range に 206 で答える（動画を seek できる）', async () => {
    const res = await projectMediaResponse(root, projectMediaUrl('assets/clip.mp4'), 'bytes=2-5')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res.text()).toBe('2345')
  })

  it('SVG はスクリプトを動かさない CSP 付きで返す', async () => {
    const res = await projectMediaResponse(root, projectMediaUrl('assets/logo.svg'), null)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
  })

  it('外を指すリンク・外へ出るパス・対象外の種類・フォルダ・パイプ・プロジェクト無しは 404', async () => {
    const statuses = await Promise.all([
      projectMediaResponse(root, projectMediaUrl('leak.png'), null),
      projectMediaResponse(root, 'ade-media://project/%2E%2E/outside/secret.png', null),
      projectMediaResponse(root, 'ade-media://project/assets/..%2F..%2Foutside%2Fsecret.png', null),
      projectMediaResponse(root, projectMediaUrl('index.html'), null),
      projectMediaResponse(root, projectMediaUrl('folder.png'), null),
      projectMediaResponse(root, projectMediaUrl('missing.png'), null),
      projectMediaResponse(null, projectMediaUrl('assets/clip.mp4'), null),
      ...(process.platform !== 'win32' ? [projectMediaResponse(root, projectMediaUrl('pipe.mp4'), null)] : [])
    ])
    expect(statuses.map((r) => r.status).every((s) => s === 404)).toBe(true)
  })

  it('大きさと先頭のバイトだけを読む（全体は読まない）', async () => {
    const info = await inspectProjectFile(root, 'blob.bin')
    expect(info.path).toBe('blob.bin')
    expect(info.size).toBe(BINARY_HEAD_BYTES + 100)
    expect(info.head).toHaveLength(BINARY_HEAD_BYTES)
    expect(info.head[0]).toBe(7)
    const small = await inspectProjectFile(root, 'assets/clip.mp4')
    expect(Buffer.from(small.head).toString()).toBe('0123456789')
  })

  it('外・フォルダ・パイプは inspect も断る', async () => {
    await expect(inspectProjectFile(root, 'leak.png')).rejects.toThrow()
    await expect(inspectProjectFile(root, '../outside/secret.png')).rejects.toThrow()
    await expect(inspectProjectFile(root, 'folder.png')).rejects.toThrow()
    if (process.platform !== 'win32') await expect(inspectProjectFile(root, 'pipe.mp4')).rejects.toThrow()
  })
})
