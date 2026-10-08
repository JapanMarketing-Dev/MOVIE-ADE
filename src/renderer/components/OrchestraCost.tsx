import { useState } from 'react'
import { COST_PERIODS, formatUsd, sumTotals, type CostPeriod, type OrchestraOverview, type TokenTotals } from '@shared/agentCost'
import { COST_CATEGORIES, sumExtra, type ExtraTotals } from '@shared/extraCost'
import type { TranslationKey } from '@shared/i18n'
import { useT } from '../lib/i18n'

const PERIOD_KEY = { month: 'orchestra.costMonth', year: 'orchestra.costYear', total: 'orchestra.costTotal' } as const

/** その期間の全部のコスト（Agent の会話の概算＋ .ferret/costs.json のインフラなど） */
export function periodUsd(overview: OrchestraOverview | null, period: CostPeriod): number {
  if (!overview) return 0
  return sumTotals([overview.orchestraCost[period], ...overview.projects.map((r) => r.cost[period])]).usd
    + sumExtra([overview.orchestraExtra[period], ...overview.projects.map((r) => r.extra[period])]).usd
}

/**
 * 全体のダッシュボードのコスト。今月・今年・総額を切り替え、全部（Agent・インフラ・サービスなど）の内訳を
 * プロダクト・種類（Agent の会話・インフラ・サービス・AI・そのほか）・項目・モデル・トークンの種類で出す。
 * Agent の会話の分は Claude Code の記録から数えた概算（総額は残っている記録の分だけ）。インフラなどは各フォルダの .ferret/costs.json
 */
export function OrchestraCost({ overview }: { overview: OrchestraOverview | null }) {
  const t = useT()
  const [period, setPeriod] = useState<CostPeriod>('month')
  const rows = [
    { id: 'orchestra', name: t('orchestra.costOrchestra'), cost: overview?.orchestraCost[period], extra: overview?.orchestraExtra[period] },
    ...(overview?.projects ?? []).map((p) => ({ id: p.id, name: p.name, cost: p.cost[period], extra: p.extra[period] }))
  ].flatMap((r) => (r.cost && r.extra ? [{ ...r, cost: r.cost as TokenTotals, extra: r.extra as ExtraTotals }] : []))
  const tokens = sumTotals(rows.map((r) => r.cost))
  const extra = sumExtra(rows.map((r) => r.extra))
  const total = tokens.usd + extra.usd
  const byProduct = rows.map((r) => [r.name, r.cost.usd + r.extra.usd, null] as const).filter(([, usd]) => usd > 0).sort((a, b) => b[1] - a[1])
  const byCategory: Array<readonly [string, number, number | null]> = [
    [t('orchestra.costCatAgent'), tokens.usd, null],
    ...COST_CATEGORIES.map((c) => [t(`orchestra.costCat.${c}` as TranslationKey), extra.byCategory[c], null] as const)
  ]
  const byItem = Object.entries(extra.items).sort((a, b) => b[1] - a[1]).map(([name, usd]) => [name, usd, null] as const)
  const byModel = Object.entries(tokens.models).sort((a, b) => b[1] - a[1]).map(([name, usd]) => [name, usd, null] as const)
  const byKind: Array<readonly [string, number, number | null]> = [
    [t('orchestra.costInput'), tokens.usdBy.input, tokens.input],
    [t('orchestra.costOutput'), tokens.usdBy.output, tokens.output],
    [t('orchestra.costCacheRead'), tokens.usdBy.cacheRead, tokens.cacheRead],
    [t('orchestra.costCacheWrite'), tokens.usdBy.cacheWrite, tokens.cacheWrite]
  ]

  return <section className="orchestra__section orchestra-cost" data-testid="orchestra-cost">
    <div className="orchestra__section-head">
      <h3>{t('orchestra.costTitle')}</h3>
      <div className="orchestra-cost__periods" role="tablist">
        {COST_PERIODS.map((p) => <button key={p} type="button" role="tab" aria-selected={p === period} className={`orchestra-cost__period${p === period ? ' is-selected' : ''}`}
          onClick={() => setPeriod(p)} data-testid={`orchestra-cost-period-${p}`}>
          <span>{t(PERIOD_KEY[p])}</span>
          <strong>{formatUsd(periodUsd(overview, p))}</strong>
        </button>)}
      </div>
    </div>
    <div className="orchestra-cost__grid">
      <Breakdown title={t('orchestra.costByProduct')} total={total} items={byProduct} empty={t('orchestra.costNone')} testId="orchestra-cost-products" />
      <Breakdown title={t('orchestra.costByCategory')} total={total} items={byCategory} empty={t('orchestra.costNone')} testId="orchestra-cost-categories" />
      <Breakdown title={t('orchestra.costByItem')} total={total} items={byItem} empty={t('orchestra.costNoItems')} testId="orchestra-cost-items" />
      <Breakdown title={t('orchestra.costByModel')} total={total} items={byModel} empty={t('orchestra.costNone')} testId="orchestra-cost-models" />
      <Breakdown title={t('orchestra.costByKind')} total={total} items={byKind} empty={t('orchestra.costNone')} testId="orchestra-cost-kinds" />
    </div>
    <p className="st-note">{t('orchestra.costNote')}{extra.estimated ? ` ${t('orchestra.costEstimated')}` : ''}</p>
  </section>
}

function Breakdown({ title, total, items, empty, testId }: { title: string; total: number; items: ReadonlyArray<readonly [string, number, number | null]>; empty: string; testId: string }) {
  const shown = items.filter(([, usd]) => usd > 0)
  return <div className="orchestra-cost__card" data-testid={testId}>
    <h4>{title}</h4>
    {shown.length === 0 ? <p className="st-note">{empty}</p> : <ul>
      {shown.map(([name, usd, tokens]) => <li key={name} title={tokens !== null ? `${tokens.toLocaleString()} tokens` : undefined}>
        <span className="orchestra-cost__name">{name}</span>
        <span className="orchestra-cost__bar"><span style={{ width: `${total > 0 ? Math.max(2, Math.round((usd / total) * 100)) : 0}%` }} /></span>
        <span className="orchestra-cost__usd">{formatUsd(usd)}</span>
      </li>)}
    </ul>}
  </div>
}
