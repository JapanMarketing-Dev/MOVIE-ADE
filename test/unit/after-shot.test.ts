import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { afterCaptureSpec, afterCommand, afterRelPath, cardShots, localTargetUrl, sanitizeAfterPath } from '@shared/afterShot'
import { resolveAfterFile } from '../../src/main/afterShots'

const dirs: string[] = []
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })

describe('AFTER のパス', () => {
  it('指摘ごとの保存先は after/<ID>.png', () => {
    expect(afterRelPath('i3')).toBe('after/i3.png')
    expect(afterRelPath('../x')).toBe('after/___x.png')
  })

  it('レビューのフォルダの中を指す画像の相対パスだけを受け付ける', () => {
    expect(sanitizeAfterPath('after/i1.png')).toBe('after/i1.png')
    expect(sanitizeAfterPath('./after/i1.jpg')).toBe('after/i1.jpg')
    expect(sanitizeAfterPath('shots/round2/i1.webp')).toBe('shots/round2/i1.webp')
    for (const bad of ['../secret.png', 'after/../../x.png', '/etc/passwd.png', 'C:/x.png', 'C:\\x.png', 'after\\i1.png', 'file:///x.png', 'after//i1.png', 'after/i1.txt', '', 42, null]) {
      expect(sanitizeAfterPath(bad)).toBeUndefined()
    }
  })

  it('実体がフォルダの外（シンボリックリンク）・無い・大きさ 0 なら読まない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferret-after-'))
    dirs.push(root)
    const review = join(root, 'review')
    await mkdir(join(review, 'after'), { recursive: true })
    await writeFile(join(review, 'after', 'i1.png'), Buffer.from('png'))
    await writeFile(join(review, 'after', 'empty.png'), Buffer.alloc(0))
    await writeFile(join(root, 'outside.png'), Buffer.from('secret'))
    await symlink(join(root, 'outside.png'), join(review, 'after', 'link.png'))
    // 実体のパス（この OS の区切り。macOS の一時フォルダは /private の下に解決される）
    expect(await resolveAfterFile(review, 'after/i1.png')).toBe(join(await realpath(review), 'after', 'i1.png'))
    expect(await resolveAfterFile(review, 'after/link.png')).toBeNull()
    // フォルダの中を指すリンクでも、末端がリンクなら読まない
    await symlink(join(review, 'after', 'i1.png'), join(review, 'after', 'inner-link.png'))
    expect(await resolveAfterFile(review, 'after/inner-link.png')).toBeNull()
    expect(await resolveAfterFile(review, 'after/empty.png')).toBeNull()
    expect(await resolveAfterFile(review, 'after/missing.png')).toBeNull()
    expect(await resolveAfterFile(review, '../outside.png')).toBeNull()
    // 途中のフォルダがリンクなら、指す先がフォルダの中でも読まない（containment.ts の assertContained）
    await mkdir(join(review, 'real'), { recursive: true })
    await writeFile(join(review, 'real', 'i9.png'), Buffer.from('png'))
    await symlink(join(review, 'real'), join(review, 'linked'))
    expect(await resolveAfterFile(review, 'real/i9.png')).toBe(join(await realpath(review), 'real', 'i9.png'))
    expect(await resolveAfterFile(review, 'linked/i9.png')).toBeNull()
  })
})

describe('localhost で撮る URL', () => {
  const presets = [{ label: 'local', url: 'http://localhost:3000' }, { label: 'dev', url: 'https://dev.acme.test/app' }, { label: 'prd', url: 'https://acme.test' }]

  it('dev / prd の指摘は確認先の local に置き換える（確認先のパスからの続きを保つ）', () => {
    expect(localTargetUrl('https://dev.acme.test/app/pricing?plan=pro#faq', presets)).toBe('http://localhost:3000/pricing?plan=pro#faq')
    expect(localTargetUrl('https://acme.test/checkout', presets)).toBe('http://localhost:3000/checkout')
    expect(localTargetUrl('https://other.test/a', presets)).toBe('http://localhost:3000/a')
  })

  it('もともと localhost ならそのまま。local が無ければ null', () => {
    expect(localTargetUrl('http://127.0.0.1:5173/x', presets)).toBe('http://127.0.0.1:5173/x')
    expect(localTargetUrl('https://acme.test/x', [{ label: 'prd', url: 'https://acme.test' }])).toBeNull()
  })

  it('撮り方: 録画時の幅と既定の高さ、保存先、Agent に依らないコマンド。ファイルのプレビューは対象外', () => {
    expect(afterCaptureSpec({ id: 'i2', context: { url: 'https://acme.test/pricing', viewport: 390 } }, presets))
      .toEqual({ url: 'http://localhost:3000/pricing', sourceUrl: 'https://acme.test/pricing', width: 390, height: 800, relPath: 'after/i2.png' })
    expect(afterCaptureSpec({ id: 'i2', context: { url: 'http://localhost:3000/' } }, presets)?.width).toBe(1280)
    expect(afterCaptureSpec({ id: 'i3', context: { url: 'ade-preview://file/docs/a.md' } }, presets)).toBeNull()
    expect(afterCaptureSpec({ id: 'i4', context: {} }, presets)).toBeNull()
    expect(afterCommand('http://localhost:3000/pricing', 390, 800, '/p/after/i2.png')).toBe('npx --yes playwright screenshot --viewport-size=390,800 "http://localhost:3000/pricing" "/p/after/i2.png"')
  })
})

describe('カードの BEFORE / AFTER', () => {
  it('両方あれば並べて比べる。done なのに AFTER が無ければ知らせる', () => {
    expect(cardShots({ before: 'b', after: 'a', progress: 'done' })).toEqual({ before: 'b', after: 'a', missingAfter: false, compare: true })
    expect(cardShots({ before: 'b', progress: 'done' })).toEqual({ before: 'b', missingAfter: true, compare: false })
    expect(cardShots({ before: 'b', progress: 'in_progress' })).toEqual({ before: 'b', missingAfter: false, compare: false })
    expect(cardShots({ after: 'a', progress: 'done' })).toEqual({ after: 'a', missingAfter: false, compare: false })
  })
})

describe('feedback.md の AFTER', () => {
  it('各指摘に localhost で撮る URL・大きさ・保存先（絶対パス）を書き、並列の単位と done の条件の節を足す', async () => {
    const { setLocale } = await import('@shared/i18n')
    setLocale('en')
    const { renderFeedbackMarkdown } = await import('../../src/main/pipeline/feedback')
    const item = (n: number, url: string, viewport?: number) => ({ id: `i${n}`, index: n, t: n * 1000, title: `Finding ${n}`, request: `Fix ${n}`, status: 'decided' as const, quotes: [],
      images: [`./0${n}.png`], frameTimes: [n * 1000], contextTime: n * 1000, context: { url, ...(viewport ? { viewport } : {}) }, draftIds: [], annotationIds: [], include: true })
    const doc = { meta: { id: '20261003-101500', startedAt: '2026-10-03T10:15:00+09:00', durationMs: 30_000, targetUrl: 'https://dev.acme.test/app/pricing', twoSpeakers: false,
      urlPresets: [{ id: 'l', label: 'local', url: 'http://localhost:3000' }, { id: 'd', label: 'dev', url: 'https://dev.acme.test/app' }] },
      items: [item(1, 'https://dev.acme.test/app/pricing', 390), item(2, 'ade-preview://file/docs/a.md')], dropped: [], organizedByLlm: true }
    const dir = '/p/acme-shop/.ferret/reviews/20261003-101500'
    const md = renderFeedbackMarkdown(doc, { locale: 'en', reviewDir: dir, progressFile: `${dir}/progress.json` })
    // 保存先はこの OS のパスで書く（Windows では区切りが \）
    const after = join(dir, 'after', 'i1.png')
    expect(md).toContain(`- AFTER: after fixing, capture http://localhost:3000/pricing at 390×800 and save it to \`${after}\``)
    expect(md.match(/^- AFTER:/gm)).toHaveLength(1)
    expect(md).toContain('## AFTER screenshots (for the reviewer)')
    expect(md).toContain('fix it → capture AFTER on localhost')
    expect(md).toContain('`human_review`')
    expect(md).toContain('Never set `done` yourself')
    expect(md).toContain('Start the dev server once and share it')
    expect(md).toContain('AFTER files are named by finding ID')
    expect(md).toContain(`npx --yes playwright screenshot --viewport-size=1280,800 "http://localhost:3000/pricing" "${after}"`)
    // 撮れなくても人には頼まず、after なしで human_review にして理由を note に1行
    expect(md).toContain('still set `human_review`, without `after`')
    expect(md).not.toContain('needs_human')
    expect(md).not.toContain('{{')
  })

  it('local の確認先が分からなければ、開発サーバーを起動して同じパスを開くよう書く', async () => {
    const { renderFeedbackMarkdown } = await import('../../src/main/pipeline/feedback')
    const doc = { meta: { id: 'x', startedAt: '2026-10-03T10:15:00+09:00', durationMs: 1000, twoSpeakers: false }, dropped: [], organizedByLlm: true,
      items: [{ id: 'i1', index: 1, t: 0, title: 'T', request: 'R', status: 'decided' as const, quotes: [], images: [], frameTimes: [], contextTime: 0, context: { url: 'https://acme.test/checkout?session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlX3ZhbHVl' }, draftIds: [], annotationIds: [], include: true }] }
    const md = renderFeedbackMarkdown(doc, { locale: 'en', progressFile: 'progress.json' })
    expect(md).toMatch(/- AFTER: after fixing, start the local dev server, open the same path as https:\/\/acme\.test\/checkout\?session=\S+ on localhost at 1280×800, and save it to `after\/i1\.png`/)
    // URL の秘密らしい値は伏せる（feedback.md の URL の行と同じ）
    expect(md).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })
})

describe('カードの点数の行', () => {
  it('判定モデルの見立てだと分かる書き方にし、選択肢の done は人の done と紛らわしくない「合格」と書く', async () => {
    const { scoreSummary } = await import('@shared/afterShot')
    const { translate } = await import('@shared/i18n')
    const ja = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('ja', key, params)
    const en = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('en', key, params)
    const score = { noul: 0.92, choice: 'done' as const, confidence: 0.66, rounds: 2 }
    expect(scoreSummary(score, ja)).toBe('判定: 合格 0.92 · 確信 0.66 · 2回')
    expect(scoreSummary(score, en)).toBe('Decision model: pass 0.92 · confidence 0.66 · 2 rounds')
    expect(scoreSummary({ noul: 0.1, choice: 'not_done', rounds: 1 }, ja)).toBe('判定: 不合格 0.10 · 1回')
    expect(scoreSummary({ noul: 0.5 }, en)).toBe('Decision model: 0.50')
    expect(scoreSummary(score, en)).not.toMatch(/\bdone\b/)
  })
})
