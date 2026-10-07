/**
 * Agent への依頼文（src/shared/agentRequests.ts）。押すとその文を Agent へ送るだけの雛形
 */
import { describe, expect, it } from 'vitest'
import { BUILTIN_REQUESTS, composeAgentRequest, dueRequests, resolveAgentRequests, sanitizeAgentRequestPrefs, toPrefs } from '../../src/shared/agentRequests'

describe('組み込みの依頼文', () => {
  it('dream・コンパクト・セキュリティ・SEO・分析・Sentry・性能・アクセシビリティ・依存関係がそろい、日本語と英語がある', () => {
    expect(BUILTIN_REQUESTS.map((b) => b.id)).toEqual(['dream', 'compact', 'security', 'seo', 'analytics', 'sentry', 'sentry-setup', 'analytics-setup', 'search-console', 'infra', 'performance', 'accessibility', 'dependencies'])
    for (const b of BUILTIN_REQUESTS) for (const lang of ['ja', 'en'] as const) expect(b.text[lang].length).toBeGreaterThan(80)
  })

  it('登録系は、接続を全体で1回にして、プロダクトごとに設定し、値を混ぜない', () => {
    for (const id of ['sentry-setup', 'analytics-setup', 'search-console', 'infra']) {
      const text = BUILTIN_REQUESTS.find((b) => b.id === id)!.text.en
      expect(text).toMatch(/once for everything/)
      expect(text).toMatch(/per product|for each public product/)
    }
  })

  it('dream は記事の4つの手順（統合・刈り込み・発見・索引）と、好みと出どころを残す決まりを持つ', () => {
    const dream = BUILTIN_REQUESTS.find((b) => b.id === 'dream')!.text.en
    for (const word of ['Consolidate', 'Prune', 'Discover', 'Index', 'explicit preferences', 'source']) expect(dream).toContain(word)
  })
})

describe('保存と一覧', () => {
  it('変えた文面・定期・まとめる印だけを保存し、既定のままのものは持たない。足した依頼文は名前と文が要る', () => {
    const list = resolveAgentRequests(undefined, 'ja').map((r) => (r.id === 'security' ? { ...r, schedule: 'weekly' as const, batch: true } : r))
    const withCustom = [...list, { id: 'custom-1', title: 'Lint', text: 'Run the linter', schedule: 'off' as const, batch: false, custom: true, edited: false }]
    const prefs = toPrefs(withCustom, 'ja')
    expect(prefs.items).toEqual([{ id: 'security', schedule: 'weekly', batch: true }, { id: 'custom-1', title: 'Lint', custom: true, text: 'Run the linter' }])
    const back = resolveAgentRequests(sanitizeAgentRequestPrefs(prefs), 'ja')
    expect(back.find((r) => r.id === 'security')).toMatchObject({ schedule: 'weekly', batch: true, edited: false })
    expect(back.at(-1)).toMatchObject({ id: 'custom-1', title: 'Lint', custom: true })
  })

  it('壊れた値・知らない組み込み・名前の無い依頼文は捨てる', () => {
    expect(sanitizeAgentRequestPrefs({ items: [{ id: 'nope' }, { id: 'x', custom: true, text: 'a' }, { id: 'bad id!' }, { id: 'seo', schedule: 'hourly' }] })).toEqual({ items: [{ id: 'seo' }] })
    expect(sanitizeAgentRequestPrefs('x')).toBeUndefined()
  })
})

describe('送る文', () => {
  const [a, b] = resolveAgentRequests(undefined, 'ja')
  it('1件はその文と共通の決まり。複数は番号付きでまとめ、並行して進めるよう添える', () => {
    const one = composeAgentRequest([a!], 'ja', false)
    expect(one.startsWith(a!.text)).toBe(true)
    expect(one).toContain('人に質問せず')
    const two = composeAgentRequest([a!, b!], 'ja', false)
    expect(two).toContain(`## 1. ${a!.title}`)
    expect(two).toContain(`## 2. ${b!.title}`)
    expect(two).toContain('並行して')
  })

  it('オーケストレーターからは、共通を先に1回、すべてのプロダクトに subagent で並行、インフラは分ける', () => {
    const text = composeAgentRequest([a!], 'en', true)
    expect(text).toMatch(/every product in parallel through each product's subagent/)
    expect(text).toMatch(/Keep infrastructure and other per-product things separate/)
  })

  it('定期：一度も送っていなければすぐ、毎日・毎週はその間隔が過ぎたら', () => {
    const now = Date.parse('2026-10-08T00:00:00Z')
    const list = resolveAgentRequests({ items: [{ id: 'dream', schedule: 'daily' }, { id: 'security', schedule: 'weekly' }, { id: 'seo', schedule: 'weekly' }] }, 'en')
    const due = dueRequests(list, { dream: '2026-10-06T23:00:00Z', security: '2026-10-03T00:00:00Z' }, now)
    expect(due.map((r) => r.id)).toEqual(['dream', 'seo'])
  })
})
