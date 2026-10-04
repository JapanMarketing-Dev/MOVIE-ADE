/**
 * 確認先の区分（アプリ・デザイン・設計書）。設定の読み込み・URL からの推定・編集の追従・ツールバーの並び・
 * 指摘の対象・feedback.md と Agent への指示への反映を確かめる。
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  addTarget,
  followPurpose,
  groupTargetsByPurpose,
  guessTargetPurpose,
  isSuggestedLabel,
  purposeAfterUrlChange,
  purposeOf,
  sanitizeProjectTargets,
  updateTarget,
  urlTarget
} from '@shared/projectTargets'
import { presetTarget } from '@shared/projectUrl'
import { buildTargetEntries, groupByTarget, targetOfUrl } from '@shared/reviewTarget'
import { renderAgentPrompt } from '@shared/agentPrompt'
import { SETTINGS_SCHEMA, validateAgainstSchema } from '@shared/settingsSchema'
import { getLocale, setLocale, translate } from '@shared/i18n'
import type { ProjectTarget } from '@shared/types'
import { assembleFromOrganized } from '../../src/main/pipeline/assemble'
import { renderFeedbackMarkdown } from '../../src/main/pipeline/feedback'
import type { OrganizeOutput } from '../../src/main/pipeline/types'
import { material } from './fixtures'

const before = getLocale()
setLocale('en')
afterAll(() => setLocale(before))

let n = 0
const newId = () => `id-${++n}`

describe('設定の読み込み（sanitizeProjectTargets）', () => {
  it('区分の無かった頃の確認先は app のまま（purpose を足さず、何も失わない）', () => {
    const legacy = [{ id: 'a', label: 'local', url: 'http://localhost:3000' }, { id: 'b', label: 'sim', launchCommand: 'open -a Simulator', windowMatch: 'Simulator' }]
    expect(sanitizeProjectTargets(legacy, newId)).toEqual(legacy)
  })

  it('design / doc は残し、app と知らない値・型違いは持たない', () => {
    const out = sanitizeProjectTargets([
      { id: 'a', label: 'Figma', url: 'https://www.figma.com/design/x', purpose: 'design' },
      { id: 'b', label: 'Spec', url: 'https://docs.google.com/document/d/x', purpose: 'doc' },
      { id: 'c', label: 'local', url: 'http://localhost:3000', purpose: 'app' },
      { id: 'd', label: 'odd', url: 'http://localhost:4000', purpose: 'figma' },
      { id: 'e', label: 'odd2', url: 'http://localhost:5000', purpose: 42 }
    ], newId)
    expect(out.map((t) => t.purpose)).toEqual(['design', 'doc', undefined, undefined, undefined])
    expect(out.map((t) => purposeOf(t))).toEqual(['design', 'doc', 'app', 'app', 'app'])
  })

  it('区分だけで中身の無い確認先は捨てる', () => {
    expect(sanitizeProjectTargets([{ id: 'a', label: 'Figma', purpose: 'design' }], newId)).toEqual([])
  })
})

describe('URL から区分を推す（guessTargetPurpose）', () => {
  it.each([
    ['https://www.figma.com/design/abc/Checkout', 'design'],
    ['https://figma.com/proto/abc', 'design'],
    ['https://design.penpot.app/#/workspace/x', 'design'],
    ['https://www.canva.com/design/abc/edit', 'design'],
    ['https://docs.google.com/document/d/abc/edit', 'doc'],
    ['https://www.notion.so/acme/Spec-123', 'doc'],
    ['https://acme.notion.site/Spec-123', 'doc'],
    ['https://acme.atlassian.net/wiki/spaces/ENG/pages/1', 'doc'],
    ['https://confluence.acme.example/display/ENG/Spec', 'doc'],
    ['https://github.com/acme/shop/blob/main/docs/checkout.md', 'doc'],
    ['https://github.com/acme/shop/wiki/Checkout', 'doc'],
    ['https://cdn.acme.example/specs/checkout.pdf', 'doc'],
    ['http://localhost:3000/', 'app'],
    ['https://dev.acme.example/pricing', 'app'],
    ['https://github.com/acme/shop/pull/1', 'app'],
    ['https://acme.atlassian.net/jira/software/projects/X', 'app']
  ])('%s → %s', (url, purpose) => {
    expect(guessTargetPurpose(url)).toBe(purpose)
  })

  it('似た名前のホスト・壊れた URL・http 以外は app（取り違えない）', () => {
    expect(guessTargetPurpose('https://figma.com.evil.example/design')).toBe('app')
    expect(guessTargetPurpose('https://notfigma.com/design')).toBe('app')
    expect(guessTargetPurpose('not a url')).toBe('app')
    expect(guessTargetPurpose('')).toBe('app')
    expect(guessTargetPurpose('file:///Users/me/spec.pdf')).toBe('app')
  })
})

describe('編集で区分が追従する（followPurpose）', () => {
  const kind = 'web' as const
  const local: ProjectTarget = { id: 't1', label: 'local' }

  it('URL に Figma を入れると design になり、自動の名前は区分の候補に付け直す', () => {
    const patch = followPurpose(local, { url: 'https://www.figma.com/design/abc' }, kind, [local])
    expect(patch).toEqual({ url: 'https://www.figma.com/design/abc', purpose: 'design', label: 'Figma' })
    const next = updateTarget([local], 't1', patch)[0]!
    expect(next).toEqual({ id: 't1', label: 'Figma', url: 'https://www.figma.com/design/abc', purpose: 'design' })
  })

  it('利用者が選び直した区分は、URL を変えても保つ', () => {
    const chosen: ProjectTarget = { id: 't1', label: 'Mock', url: 'http://localhost:6006', purpose: 'design' }
    expect(purposeAfterUrlChange(chosen, 'http://localhost:6007')).toBe('design')
    expect(followPurpose(chosen, { url: 'http://localhost:6007' }, kind)).toEqual({ url: 'http://localhost:6007' })
  })

  it('利用者が付けた名前は区分を変えても変えない', () => {
    const named: ProjectTarget = { id: 't1', label: 'Checkout mock', url: 'http://localhost:3000' }
    expect(followPurpose(named, { purpose: 'design' }, kind)).toEqual({ purpose: 'design' })
  })

  it('区分の候補は兄弟と重ならない（Spec の次は PRD）', () => {
    const siblings: ProjectTarget[] = [{ id: 's', label: 'Spec', url: 'https://docs.google.com/document/d/a', purpose: 'doc' }, local]
    expect(followPurpose(local, { purpose: 'doc' }, kind, siblings).label).toBe('PRD')
  })

  it('app に戻すと purpose を設定に残さない', () => {
    const design: ProjectTarget = { id: 't1', label: 'Figma', url: 'https://www.figma.com/design/abc', purpose: 'design' }
    expect(updateTarget([design], 't1', { purpose: 'app' })[0]).toEqual({ id: 't1', label: 'Figma', url: 'https://www.figma.com/design/abc' })
  })

  it('自動の名前かどうか', () => {
    expect(isSuggestedLabel('', kind)).toBe(true)
    expect(isSuggestedLabel('local', kind)).toBe(true)
    expect(isSuggestedLabel('Figma 2', kind)).toBe(true)
    expect(isSuggestedLabel('Design doc', kind)).toBe(true)
    expect(isSuggestedLabel('Checkout flow', kind)).toBe(false)
    expect(isSuggestedLabel('local dev', kind)).toBe(false)
  })

  it('addTarget は区分の候補で名前を付け、区分を持たせる', () => {
    const list = addTarget([], kind, { purpose: 'doc', url: ' https://www.notion.so/acme/Spec ' }, 'n1')
    expect(list).toEqual([{ id: 'n1', label: 'Spec', url: 'https://www.notion.so/acme/Spec', purpose: 'doc' }])
  })

  it('開いている URL から確認先を作る（urlTarget）', () => {
    expect(urlTarget('https://www.figma.com/design/abc', kind, [], 'u1')).toEqual({ id: 'u1', label: 'Figma', url: 'https://www.figma.com/design/abc', purpose: 'design' })
    expect(urlTarget('http://localhost:3000/', kind, [], 'u2')).toEqual({ id: 'u2', label: 'local', url: 'http://localhost:3000/' })
  })
})

describe('ツールバーの並びと切り替え', () => {
  const targets: ProjectTarget[] = [
    { id: 'spec', label: 'Spec', url: 'http://127.0.0.1:4100/spec.html', purpose: 'doc' },
    { id: 'local', label: 'local', url: 'http://localhost:3000' },
    { id: 'figma', label: 'Figma', url: 'http://127.0.0.1:4100/design.html', purpose: 'design' },
    { id: 'dev', label: 'dev', url: 'https://dev.acme.example' }
  ]

  it('アプリ → デザイン → 設計書の順にまとめ、区分の中は登録の順', () => {
    expect(groupTargetsByPurpose(targets).map((g) => [g.purpose, g.targets.map((t) => t.id)])).toEqual([
      ['app', ['local', 'dev']], ['design', ['figma']], ['doc', ['spec']]
    ])
    expect(groupTargetsByPurpose([])).toEqual([])
  })

  it('アプリどうしは同じパスのまま切り替え、デザイン・設計書との行き来は登録した URL を開く', () => {
    const urls = targets as Array<ProjectTarget & { url: string }>
    expect(presetTarget(urls, 'http://localhost:3000/pricing?a=1', urls[3]!)).toBe('https://dev.acme.example/pricing?a=1')
    expect(presetTarget(urls, 'http://localhost:3000/pricing', urls[2]!)).toBe('http://127.0.0.1:4100/design.html')
    expect(presetTarget(urls, 'http://127.0.0.1:4100/design.html', urls[1]!)).toBe('http://localhost:3000')
  })
})

describe('指摘の対象に区分を付ける', () => {
  const presets: ProjectTarget[] = [
    { id: 'local', label: 'local', url: 'http://localhost:3000' },
    { id: 'spec', label: 'Spec', url: 'http://127.0.0.1:4100/spec', purpose: 'doc' }
  ]

  it('登録した確認先の区分を使い、登録外は URL から推す', () => {
    expect(targetOfUrl('http://127.0.0.1:4100/spec#s2', presets)).toMatchObject({ label: 'Spec', purpose: 'doc' })
    expect(targetOfUrl('http://localhost:3000/a', presets).purpose).toBeUndefined()
    expect(targetOfUrl('https://www.figma.com/design/abc', presets).purpose).toBe('design')
    expect(targetOfUrl(undefined, presets).purpose).toBeUndefined()
  })

  it('右パネルの候補にも区分が付く', () => {
    const entries = buildTargetEntries({ presets, files: [], recent: ['https://docs.google.com/document/d/x'] })
    expect(entries.map((e) => [e.title, e.purpose])).toEqual([['local', undefined], ['Spec', 'doc'], ['docs.google.com/document/d/x', 'doc']])
  })
})

const organized: OrganizeOutput = {
  items: [
    { title: 'Heading too small', request: 'Make the top heading larger', status: 'decided', quotes: [{ speaker: 'self', t: 2_000, text: 'small' }], frame_times: [3_000], annotation_ids: [] },
    { title: 'Spec says the button is blue', request: 'Fix the button color in the spec', status: 'decided', quotes: [{ speaker: 'self', t: 18_000, text: 'blue' }], frame_times: [19_750], annotation_ids: [] }
  ],
  dropped: []
}

describe('feedback.md と Agent への指示', () => {
  it('設計書で撮った指摘の節に区分の行を書き、冒頭に「コードではなく文書を直す」注意を書く', () => {
    const doc = assembleFromOrganized(material, organized)
    doc.meta = { ...doc.meta, urlPresets: [{ id: 'spec', label: 'Spec', url: 'http://localhost:3000/pricing', purpose: 'doc' }] }
    const md = renderFeedbackMarkdown(doc, { locale: 'en' })
    expect(md).toContain(translate('en', 'feedbackMd.nonCodeNote'))
    const pricing = md.slice(md.indexOf('localhost:3000/pricing'))
    expect(pricing).toContain(`- Environment: Spec\n${translate('en', 'feedbackMd.kind.doc')}\n- URL: http://localhost:3000/pricing`)
    // アプリの節には区分の行を書かない
    const top = md.slice(0, md.indexOf('localhost:3000/pricing'))
    expect(top).not.toContain(translate('en', 'feedbackMd.kind.doc'))
  })

  it('アプリだけの録画には区分の行も注意も書かない', () => {
    const doc = assembleFromOrganized(material, organized)
    const md = renderFeedbackMarkdown(doc, { locale: 'en' })
    expect(md).not.toContain(translate('en', 'feedbackMd.nonCodeNote'))
    expect(md).not.toContain('- Kind:')
  })

  it('対象が1つ（デザイン）なら、対象の行の下に区分を書く', () => {
    const doc = assembleFromOrganized({ ...material, events: material.events.filter((e) => e.type !== 'nav' || !e.url.includes('pricing')) }, organized)
    doc.meta = { ...doc.meta, urlPresets: [{ id: 'f', label: 'Figma', url: 'http://localhost:3000', purpose: 'design' }] }
    for (const it of doc.items) it.context = { ...it.context, url: 'http://localhost:3000/' }
    const md = renderFeedbackMarkdown(doc, { locale: 'ja' })
    expect(md).toContain(translate('ja', 'feedbackMd.kind.design'))
    expect(md).toContain(translate('ja', 'feedbackMd.nonCodeNote'))
  })

  it('送る指摘に設計書の指摘が無ければ（focusIds で外れた）注意を書かない', () => {
    const doc = assembleFromOrganized(material, organized)
    doc.meta = { ...doc.meta, urlPresets: [{ id: 'spec', label: 'Spec', url: 'http://localhost:3000/pricing', purpose: 'doc' }] }
    const appItem = groupByTarget(doc.items, (it) => it.context.url, doc.meta.urlPresets).find((g) => !g.target.purpose)!.items[0]!
    const md = renderFeedbackMarkdown(doc, { locale: 'en', focusIds: [appItem.id] })
    expect(md).not.toContain(translate('en', 'feedbackMd.nonCodeNote'))
  })

  it('Agent への指示は、デザイン・設計書の指摘があるときだけ1文足す（書き換えた文面でも）', () => {
    const base = { relativeDir: '.ferret/reviews/1' }
    expect(renderAgentPrompt(base, null, 'en')).not.toContain(translate('en', 'agentPrompt.nonCode'))
    expect(renderAgentPrompt({ ...base, nonCode: true }, null, 'en')).toContain(translate('en', 'agentPrompt.nonCode'))
    expect(renderAgentPrompt({ ...base, nonCode: true }, 'Read {{path}}', 'ja')).toBe(`Read .ferret/reviews/1/feedback.md ${translate('ja', 'agentPrompt.nonCode')}`)
  })
})

describe('設定のスキーマ', () => {
  it('確認先の purpose は app / design / doc の列挙で、既定は app', () => {
    const item = SETTINGS_SCHEMA.properties!.projects!.items!.properties!.urls!.items!
    expect(item.properties!.purpose!.enum).toEqual(['app', 'design', 'doc'])
    expect(item.properties!.purpose!.default).toBe('app')
    expect(validateAgainstSchema({ id: 'a', label: 'Figma', url: 'https://www.figma.com/design/x', purpose: 'design' }, item)).toEqual([])
    expect(validateAgainstSchema({ id: 'a', label: 'x', url: 'https://x.example', purpose: 'whiteboard' }, item).length).toBeGreaterThan(0)
  })
})
