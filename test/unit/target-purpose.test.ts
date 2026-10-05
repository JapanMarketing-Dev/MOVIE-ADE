/**
 * 確認先の区分（アプリ・デザイン・設計書・参考）。設定の読み込み・URL からの推定・編集の追従・ツールバーの並び・
 * 指摘の対象・feedback.md と Agent への指示への反映を確かめる。
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  addTarget,
  followPurpose,
  isLocalHost,
  looksLikeReferenceLabel,
  registeredPurpose,
  unregisteredUrlPurpose,
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
import { renderAgentSkill } from '@shared/agentSkill'
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
  it('確認先の purpose は app / design / doc / reference の列挙で、既定は app', () => {
    const item = SETTINGS_SCHEMA.properties!.projects!.items!.properties!.urls!.items!
    expect(item.properties!.purpose!.enum).toEqual(['app', 'design', 'doc', 'reference'])
    expect(item.properties!.purpose!.default).toBe('app')
    expect(validateAgainstSchema({ id: 'a', label: 'Figma', url: 'https://www.figma.com/design/x', purpose: 'design' }, item)).toEqual([])
    expect(validateAgainstSchema({ id: 'a', label: '競合', url: 'https://competitor.example', purpose: 'reference' }, item)).toEqual([])
    expect(validateAgainstSchema({ id: 'a', label: 'x', url: 'https://x.example', purpose: 'whiteboard' }, item).length).toBeGreaterThan(0)
  })
})

// ───────────────────────── 参考（外部サイト）─────────────────────────

describe('参考（外部サイト）の見分け', () => {
  const own: ProjectTarget[] = [
    { id: 'local', label: 'local', url: 'http://localhost:3000' },
    { id: 'dev', label: 'dev', url: 'https://dev.acme.example' },
    { id: 'prd', label: 'prd', url: 'https://www.acme.example/app' },
    { id: 'figma', label: 'Figma', url: 'https://www.figma.com/design/x', purpose: 'design' }
  ]

  it('登録で reference を選んだ確認先は reference（設定にも残る）', () => {
    const ref: ProjectTarget = { id: 'r', label: 'お手本', url: 'https://bid-info.example', purpose: 'reference' }
    expect(registeredPurpose(ref)).toBe('reference')
    expect(sanitizeProjectTargets([ref], newId)[0]!.purpose).toBe('reference')
    expect(targetOfUrl('https://bid-info.example/list', [...own, ref])).toMatchObject({ label: 'お手本', purpose: 'reference' })
  })

  it.each(['競合:調達info', '参考 A社', 'Competitor', 'my REFERENCE site', '競合（ＴＯＰ）'])('名前「%s」のアプリの確認先は reference とみなす', (label) => {
    expect(looksLikeReferenceLabel(label)).toBe(true)
    expect(registeredPurpose({ label, url: 'https://bid-info.example' })).toBe('reference')
  })

  it('ふつうの名前・デザイン・設計書の区分は変えない（名前に参考とあっても design / doc はそのまま）', () => {
    expect(looksLikeReferenceLabel('dev')).toBe(false)
    expect(looksLikeReferenceLabel(undefined)).toBe(false)
    expect(registeredPurpose({ label: 'prd', url: 'https://www.acme.example' })).toBe('app')
    expect(registeredPurpose({ label: '参考デザイン', purpose: 'design' })).toBe('design')
    expect(registeredPurpose({ label: 'Reference spec', purpose: 'doc' })).toBe('doc')
  })

  it('スクリーンショットの例: 登録名「競合:調達info」で撮った指摘の対象は reference', () => {
    const presets: ProjectTarget[] = [...own, { id: 'c', label: '競合:調達info', url: 'https://bid-info.example' }]
    expect(targetOfUrl('https://bid-info.example/search?q=x', presets)).toMatchObject({ label: '競合:調達info', purpose: 'reference' })
    // 競合の確認先のホストは自分のアプリのホストに数えない
    expect(unregisteredUrlPurpose('https://bid-info.example/other', presets)).toBe('reference')
  })

  it('登録外の外部ホストは、自分のアプリ（local / dev / prd）のどのホストとも違えば reference', () => {
    expect(targetOfUrl('https://competitor.example/pricing', own).purpose).toBe('reference')
    expect(unregisteredUrlPurpose('https://competitor.example/', own)).toBe('reference')
  })

  it('自分のアプリのホスト（dev / prd とそのサブドメイン・www の有無）は app のまま', () => {
    expect(targetOfUrl('https://dev.acme.example/other', own).purpose).toBeUndefined()
    expect(unregisteredUrlPurpose('https://acme.example/blog', own)).toBe('app')
    expect(unregisteredUrlPurpose('https://api.dev.acme.example/x', own)).toBe('app')
    expect(unregisteredUrlPurpose('https://www.acme.example/other', own)).toBe('app')
  })

  it('手元のホスト（localhost・127.0.0.1・::1・*.local・プライベート IP）は app のまま', () => {
    for (const url of ['http://localhost:5173/', 'http://127.0.0.1:8080/x', 'http://[::1]:3000/', 'http://myapp.local/', 'http://192.168.1.20:3000/', 'http://10.0.0.5/', 'http://172.20.0.2/']) {
      expect(unregisteredUrlPurpose(url, own)).toBe('app')
    }
    expect(isLocalHost('localhost')).toBe(true)
    expect(isLocalHost('[::1]')).toBe(true)
    expect(isLocalHost('172.32.0.1')).toBe(false)
    expect(isLocalHost('acme.example')).toBe(false)
  })

  it('デザイン・設計書のホスト（Figma・Google Docs）は外部でも design / doc のまま', () => {
    expect(unregisteredUrlPurpose('https://www.figma.com/design/other', own)).toBe('design')
    expect(targetOfUrl('https://docs.google.com/document/d/x', own).purpose).toBe('doc')
  })

  it('アプリの確認先（URL のあるもの）が1つも無いプロジェクトでは、外部のホストを参考にしない', () => {
    expect(unregisteredUrlPurpose('https://competitor.example/', [])).toBe('app')
    expect(targetOfUrl('https://competitor.example/', []).purpose).toBeUndefined()
    // デザインだけ・ウインドウだけの確認先も、自分のアプリのホストは分からない
    expect(unregisteredUrlPurpose('https://competitor.example/', [{ label: 'Figma', url: 'https://www.figma.com/design/x', purpose: 'design' }, { label: 'sim' }])).toBe('app')
    // 名前で reference にした確認先しか無いときも同じ
    expect(unregisteredUrlPurpose('https://other.example/', [{ label: '競合', url: 'https://competitor.example' }])).toBe('app')
  })

  it('http 以外・壊れた URL・ファイルのプレビューは reference にしない', () => {
    expect(unregisteredUrlPurpose('not a url', own)).toBe('app')
    expect(unregisteredUrlPurpose('file:///Users/taro/a.html', own)).toBe('app')
    expect(targetOfUrl('ade-preview://local/docs/a.md', own).purpose).toBeUndefined()
  })

  it('右パネルの候補にも reference が付く（登録・最近の URL）', () => {
    const presets: ProjectTarget[] = [own[0]!, { id: 'c', label: '競合', url: 'https://competitor.example' }]
    const entries = buildTargetEntries({ presets, files: [], recent: ['https://inspiration.example/a'] })
    expect(entries.map((e) => [e.title, e.purpose])).toEqual([['local', undefined], ['競合', 'reference'], ['inspiration.example/a', 'reference']])
  })

  it('名前に「競合」と書くと、選び直していないアプリの確認先は reference を勧める（選び直した区分は保つ）', () => {
    const target: ProjectTarget = { id: 't', label: 'local', url: 'https://bid-info.example' }
    expect(followPurpose(target, { label: '競合:調達info' }, 'web')).toEqual({ label: '競合:調達info', purpose: 'reference' })
    expect(followPurpose({ ...target, purpose: 'design' }, { label: '参考デザイン' }, 'web')).toEqual({ label: '参考デザイン' })
    expect(followPurpose(target, { label: 'dev' }, 'web')).toEqual({ label: 'dev' })
  })

  it('区分の候補・並びに reference が入り、URL を変えても選んだ reference は保つ', () => {
    expect(addTarget([], 'web', { purpose: 'reference', url: 'https://competitor.example' }, 'n')).toEqual([{ id: 'n', label: 'Reference', url: 'https://competitor.example', purpose: 'reference' }])
    expect(isSuggestedLabel('Competitor', 'web')).toBe(true)
    expect(groupTargetsByPurpose([{ id: 'r', label: 'x', purpose: 'reference' }, { id: 'a', label: 'local' }]).map((g) => g.purpose)).toEqual(['app', 'reference'])
    expect(purposeAfterUrlChange({ url: 'https://a.example', purpose: 'reference' }, 'https://b.example')).toBe('reference')
  })
})

const referenceOrganized: OrganizeOutput = {
  items: [
    { title: 'Use the procurement site as a model', request: '調達インフォを参考にする', status: 'decided', quotes: [{ speaker: 'self', t: 2_000, text: '調達インフォですね これを参考にしてください' }], frame_times: [3_000], annotation_ids: [] },
    { title: 'Black background is bad', request: '黒背景は避ける', status: 'decided', quotes: [{ speaker: 'self', t: 18_000, text: 'この黒背景ダメっすね' }], frame_times: [19_750], annotation_ids: [] }
  ],
  dropped: []
}

describe('参考（外部サイト）の feedback.md と Agent への指示', () => {
  const competitorDoc = () => {
    const doc = assembleFromOrganized(material, referenceOrganized)
    doc.meta = { ...doc.meta, urlPresets: [{ id: 'local', label: 'local', url: 'http://localhost:3000/' }, { id: 'c', label: '競合:調達info', url: 'https://bid-info.example/' }] }
    // 2つ目の指摘は競合のサイトで撮った
    doc.items[1]!.context = { ...doc.items[1]!.context, url: 'https://bid-info.example/list' }
    return doc
  }

  it.each(['ja', 'en'] as const)('%s: 参考の節に区分の行と、取り入れる・避ける・対応不要の指示を書き、needs_human は書かない', (locale) => {
    const md = renderFeedbackMarkdown(competitorDoc(), { locale })
    expect(md).toContain(translate(locale, 'feedbackMd.referenceNote'))
    expect(md).toContain(translate(locale, 'feedbackMd.progress.reference'))
    const at = md.indexOf('bid-info.example')
    expect(md.slice(at)).toContain(translate(locale, 'feedbackMd.kind.reference'))
    // アプリの節には参考の区分の行を書かない
    expect(md.slice(0, at)).not.toContain(translate(locale, 'feedbackMd.kind.reference'))
    // デザイン・文書を直す注意（nonCode）は書かない
    expect(md).not.toContain(translate(locale, 'feedbackMd.nonCodeNote'))
    expect(md).not.toContain('needs_human')
  })

  it('ja: 外部サイトを直させず、対応不要は note に書いて human_review にさせる（質問させない）', () => {
    const note = translate('ja', 'feedbackMd.referenceNote')
    expect(note).toContain('直せないので、変えようとしないこと')
    expect(note).toContain('外部サイトのため対応不要（参考）')
    expect(note).toContain('`human_review`')
    expect(note).toContain('質問しない')
    expect(translate('ja', 'feedbackMd.kind.reference')).toContain('変えない')
  })

  it('en: the external site is never to be changed', () => {
    expect(translate('en', 'feedbackMd.referenceNote')).toContain('never try to change it')
    expect(translate('en', 'feedbackMd.progress.reference')).toContain('never changes that external site')
  })

  it('参考の指摘が送る範囲に無ければ（focusIds で外れた）注意も進み具合の1行も書かない', () => {
    const doc = competitorDoc()
    const md = renderFeedbackMarkdown(doc, { locale: 'en', focusIds: [doc.items[0]!.id] })
    expect(md).not.toContain(translate('en', 'feedbackMd.referenceNote'))
    expect(md).not.toContain(translate('en', 'feedbackMd.progress.reference'))
  })

  it('登録外の外部サイトで撮っても（アプリの確認先と違うホスト）参考として渡す', () => {
    const doc = assembleFromOrganized(material, referenceOrganized)
    doc.meta = { ...doc.meta, urlPresets: [{ id: 'local', label: 'local', url: 'http://localhost:3000/' }] }
    doc.items[1]!.context = { ...doc.items[1]!.context, url: 'https://competitor.example/' }
    const md = renderFeedbackMarkdown(doc, { locale: 'en' })
    expect(md).toContain(translate('en', 'feedbackMd.kind.reference'))
    expect(md).toContain(translate('en', 'feedbackMd.referenceNote'))
  })

  it('Agent への指示は、参考の指摘があるときだけ1文足す（書き換えた文面でも）', () => {
    const base = { relativeDir: '.ferret/reviews/1' }
    expect(renderAgentPrompt(base, null, 'en')).not.toContain(translate('en', 'agentPrompt.reference'))
    expect(renderAgentPrompt({ ...base, reference: true }, null, 'en')).toContain(translate('en', 'agentPrompt.reference'))
    expect(renderAgentPrompt({ ...base, reference: true }, 'Read {{path}}', 'ja')).toBe(`Read .ferret/reviews/1/feedback.md ${translate('ja', 'agentPrompt.reference')}`)
  })

  it('ferret-settings の skill に reference の区分と説明が出る（スキーマから作る）', () => {
    const skill = renderAgentSkill({ settingsPath: '/Users/taro/.ferret/settings.json', schemaPath: '/Users/taro/.ferret/settings.schema.json', version: '9.9.9' })
    const row = skill.split('\n').find((line) => line.startsWith('| `projects[].urls[].purpose` |'))!
    expect(row).toContain('"reference"')
    expect(row).toContain('competitor')
  })
})
