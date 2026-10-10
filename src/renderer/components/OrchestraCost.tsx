import { useState } from 'react'
import { COST_CATEGORIES, COST_PERIODS, formatUsd, sumExtra, sumForecast, type CostPeriod, type ExtraTotals } from '@shared/extraCost'
import type { OrchestraOverview } from '@shared/orchestraOverview'
import type { TranslationKey } from '@shared/i18n'
import { useT } from '../lib/i18n'

const PERIOD_KEY = { month: 'orchestra.costMonth', year: 'orchestra.costYear', total: 'orchestra.costTotal' } as const

type Row = readonly [string, number, string | null]

/** その期間のインフラの実績（各プロダクトと全体のフォルダの .ferret/costs.json） */
export function periodUsd(overview: OrchestraOverview | null, period: CostPeriod): number {
  if (!overview) return 0
  return sumExtra([overview.orchestraExtra[period], ...overview.projects.map((r) => r.extra[period])]).usd
}

/** 今のリソースから見た推定の月額（全部のフォルダの合計） */
export function forecastUsd(overview: OrchestraOverview | null): number {
  if (!overview) return 0
  return sumForecast([overview.orchestraForecast, ...overview.projects.map((r) => r.forecast)]).usd
}

/**
 * 全体のダッシュボードのインフラのコスト。AI（Agent の会話・サブスクリプション）は出さない。
 * 実績は今月・今年・総額を切り替え、プロダクト・事業者（AWS・Cloudflare・Google Cloud など）・費目・項目の内訳で出す。
 * 推定は今動いているリソースからの月額を、プロダクト・事業者・リソースの内訳で出す
 */
export function OrchestraCost({ overview }: { overview: OrchestraOverview | null }) {
  const t = useT()
  const [period, setPeriod] = useState<CostPeriod>('month')
  const other = t('orchestra.costProviderOther')
  const rows = [
    { id: 'orchestra', name: t('orchestra.costOrchestra'), extra: overview?.orchestraExtra[period], forecast: overview?.orchestraForecast },
    ...(overview?.projects ?? []).map((p) => ({ id: p.id, name: p.name, extra: p.extra[period], forecast: p.forecast }))
  ].flatMap((r) => (r.extra && r.forecast ? [{ ...r, extra: r.extra as ExtraTotals, forecast: r.forecast }] : []))
  const extra = sumExtra(rows.map((r) => r.extra))
  const forecast = sumForecast(rows.map((r) => r.forecast))
  const sorted = (record: Record<string, number>, basis: Record<string, string> = {}): Row[] =>
    Object.entries(record).sort((a, b) => b[1] - a[1]).map(([name, usd]) => [name || other, usd, basis[name] ?? null] as const)
  const byProduct: Row[] = rows.map((r) => [r.name, r.extra.usd, null] as const).sort((a, b) => b[1] - a[1])
  const byCategory: Row[] = COST_CATEGORIES.map((c) => [t(`orchestra.costCat.${c}` as TranslationKey), extra.byCategory[c], null] as const)
  const forecastByProduct: Row[] = rows.map((r) => [r.name, r.forecast.usd, null] as const).sort((a, b) => b[1] - a[1])

  return <section className="orchestra__section orchestra-cost" data-testid="orchestra-cost">
    <div className="orchestra__section-head">
      <h3>{t('orchestra.costTitle')}</h3>
      <div className="orchestra-cost__periods" role="tablist">
        {COST_PERIODS.map((p) => <button key={p} type="button" role="tab" aria-selected={p === period} className={`orchestra-cost__period${p === period ? ' is-selected' : ''}`}
          onClick={() => setPeriod(p)} data-testid={`orchestra-cost-period-${p}`}>
          <span>{t(PERIOD_KEY[p])}</span>
          <strong>{formatUsd(periodUsd(overview, p))}</strong>
        </button>)}
        <div className="orchestra-cost__period orchestra-cost__forecast" data-testid="orchestra-cost-forecast">
          <span>{t('orchestra.costForecast')}</span>
          <strong>{formatUsd(forecast.usd)}</strong>
        </div>
      </div>
    </div>
    <h4 className="orchestra-cost__group">{t('orchestra.costActual')}</h4>
    <div className="orchestra-cost__grid">
      <Breakdown title={t('orchestra.costByProduct')} total={extra.usd} items={byProduct} empty={t('orchestra.costNone')} testId="orchestra-cost-products" />
      <Breakdown title={t('orchestra.costByProvider')} total={extra.usd} items={sorted(extra.byProvider)} empty={t('orchestra.costNone')} testId="orchestra-cost-providers" />
      <Breakdown title={t('orchestra.costByCategory')} total={extra.usd} items={byCategory} empty={t('orchestra.costNone')} testId="orchestra-cost-categories" />
      <Breakdown title={t('orchestra.costByItem')} total={extra.usd} items={sorted(extra.items)} empty={t('orchestra.costNoItems')} testId="orchestra-cost-items" />
    </div>
    <h4 className="orchestra-cost__group">
      {t('orchestra.costForecastTitle')}
      {forecast.checkedAt && <span className="st-note"> {t('orchestra.costForecastAsOf', { date: forecast.checkedAt })}</span>}
    </h4>
    <div className="orchestra-cost__grid">
      <Breakdown title={t('orchestra.costByProduct')} total={forecast.usd} items={forecastByProduct} empty={t('orchestra.costNoForecast')} testId="orchestra-forecast-products" />
      <Breakdown title={t('orchestra.costByProvider')} total={forecast.usd} items={sorted(forecast.byProvider)} empty={t('orchestra.costNoForecast')} testId="orchestra-forecast-providers" />
      <Breakdown title={t('orchestra.costByResource')} total={forecast.usd} items={sorted(forecast.items, forecast.basis)} empty={t('orchestra.costNoForecast')} testId="orchestra-forecast-items" />
    </div>
    <p className="st-note">
      {t('orchestra.costNote')}
      {extra.estimated ? ` ${t('orchestra.costEstimated')}` : ''}
      {forecast.fromRecurring ? ` ${t('orchestra.costForecastFromRecurring')}` : ''}
    </p>
  </section>
}

function Breakdown({ title, total, items, empty, testId }: { title: string; total: number; items: readonly Row[]; empty: string; testId: string }) {
  const shown = items.filter(([, usd]) => usd > 0)
  return <div className="orchestra-cost__card" data-testid={testId}>
    <h4>{title}</h4>
    {shown.length === 0 ? <p className="st-note">{empty}</p> : <ul>
      {shown.map(([name, usd, hint]) => <li key={name} title={hint ?? undefined}>
        <span className="orchestra-cost__name">{name}</span>
        <span className="orchestra-cost__bar"><span style={{ width: `${total > 0 ? Math.max(2, Math.round((usd / total) * 100)) : 0}%` }} /></span>
        <span className="orchestra-cost__usd">{formatUsd(usd)}</span>
      </li>)}
    </ul>}
  </div>
}
