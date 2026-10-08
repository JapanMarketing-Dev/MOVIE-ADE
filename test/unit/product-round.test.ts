/**
 * プロダクトの巡回（src/shared/productRound.ts）と、全体の共通・個別のルール（src/shared/orchestrator.ts）
 */
import { describe, expect, it } from 'vitest'
import { confirmRound, currentStep, nextRound, roundProducts } from '../../src/shared/productRound'
import { renderOrchestratorGuide, renderSubagent, sanitizeOrchestraRules } from '../../src/shared/orchestrator'
import type { Project } from '../../src/shared/types'

const p = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, folderPath: `/${id}`, urls: [], ...extra })
const all = [p('all', { editorWorkspace: true, orchestrator: true }), p('shop'), p('old', { orchestrator: true }), p('remote', { source: 'ssh' }), p('blog')]

describe('巡回するプロダクト', () => {
  it('全体・以前のオーケストレーター・SSH は入れず、サイドバーの順', () => {
    expect(roundProducts(all).map((x) => x.id)).toEqual(['shop', 'blog'])
  })

  it('確認の巡回：確認待ちのあるレビューだけを、プロダクトの順に', () => {
    const r = confirmRound([
      { projectId: 'blog', reviewId: 'b1', count: 2 },
      { projectId: 'shop', reviewId: 's1', count: 0 },
      { projectId: 'shop', reviewId: 's2', count: 1 }
    ], all.map((x) => x.id))!
    expect(r.steps).toEqual([{ projectId: 'shop', reviewId: 's2' }, { projectId: 'blog', reviewId: 'b1' }])
    expect(confirmRound([], [])).toBeNull()
  })

  it('確認の巡回は「次へ」で1つずつ進み、最後で終わる（自動では進まない）。録画の巡回は無い', async () => {
    const r = confirmRound([{ projectId: 'shop', reviewId: 's1', count: 1 }, { projectId: 'blog', reviewId: 'b1', count: 1 }], all.map((x) => x.id))!
    expect(currentStep(r)).toEqual({ projectId: 'shop', reviewId: 's1' })
    const second = nextRound(r)!
    expect(currentStep(second)).toEqual({ projectId: 'blog', reviewId: 'b1' })
    expect(nextRound(second)).toBeNull()
    const { readFile } = await import('node:fs/promises')
    const hook = await readFile(new URL('../../src/renderer/hooks/useProductRound.ts', import.meta.url), 'utf8')
    expect(hook).not.toMatch(/useEffect/)
    expect(hook).not.toContain("'record'")
  })
})

describe('共通のルールとプロダクトごとのルール', () => {
  const child = { dir: 'shop', path: '/w/shop', outside: '/code/shop', projectId: 'shop', name: 'shop', agent: 'ferret-shop' }
  const rules = sanitizeOrchestraRules({ shared: 'Run the security check weekly.', products: { shop: 'AWS account 1234, tag team=shop', blog: '   ', 'bad id!': 'x' } })!

  it('空のもの・使えない id は捨てる', () => {
    expect(rules).toEqual({ shared: 'Run the security check weekly.', products: { shop: 'AWS account 1234, tag team=shop' } })
    expect(sanitizeOrchestraRules({ shared: ' ' })).toBeUndefined()
  })

  it('全体の CLAUDE.md の欄と、そのプロダクトの subagent に入る（ほかのプロダクトのルールは入らない）', () => {
    const guide = renderOrchestratorGuide([child], rules)
    expect(guide).toContain('### Shared rules (set by the human in Ferret)\n\nRun the security check weekly.')
    expect(guide).toContain('### Rules only for shop (set by the human in Ferret)\n\nAWS account 1234, tag team=shop')
    const sub = renderSubagent(child, rules)
    expect(sub).toContain('Run the security check weekly.')
    expect(sub).toContain('Rules only for shop')
    expect(renderSubagent({ ...child, projectId: 'blog', name: 'blog', agent: 'ferret-blog' }, rules)).not.toContain('AWS account 1234')
  })
})
