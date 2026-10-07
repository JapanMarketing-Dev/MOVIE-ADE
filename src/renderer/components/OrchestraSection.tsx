import { useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import type { OrchestraRules } from '@shared/orchestrator'
import { roundProducts } from '@shared/productRound'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { useToast } from '../ui'

/**
 * 設定の「オーケストラ」。全体（すべてのプロダクト）で、人が共通のルールとプロダクトごとのルールを書く。
 * 共通：規約・セキュリティ・デザイン・ドキュメントなど全プロダクトで揃えること。
 * 個別：インフラ・タグ・インスタンス・デプロイなどプロダクトごとに分けること。
 * 書いたものは全体の CLAUDE.md / AGENTS.md と、各プロダクトの subagent に入る（main の settings:orchestra）
 */
export function OrchestraSection() {
  const t = useT()
  const toast = useToast()
  const [rules, setRules] = useState<OrchestraRules | null>(null)
  const [products, setProducts] = useState<Project[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([window.ade.invoke('app:settings'), window.ade.invoke('project:list')]).then(([s, list]) => {
      if (cancelled) return
      setRules(s.orchestra ?? {})
      setProducts(roundProducts(list.projects))
    }).catch(() => { if (!cancelled) setRules({}) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  /** 入力のたびに書かず、少し待ってまとめて保存する（保存すると全体の CLAUDE.md と subagent を書き直す） */
  const update = (next: OrchestraRules) => {
    setRules(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void window.ade.invoke('settings:orchestra', next).catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
    }, 500)
  }

  if (!rules) return <p className="st-note">{t('usage.loading')}</p>
  return <div className="orchestra-rules" data-testid="orchestra-rules">
    <p className="st-note">{t('orchestra.intro')}</p>
    <label className="pt-field">
      <span>{t('orchestra.shared')}</span>
      <textarea className="st-textarea" rows={5} value={rules.shared ?? ''} placeholder={t('orchestra.sharedPlaceholder')} spellCheck={false}
        onChange={(e) => update({ ...rules, shared: e.target.value })} data-testid="orchestra-shared" />
    </label>
    <h3 className="st-page__subheading">{t('orchestra.products')}</h3>
    {products.length === 0 && <p className="st-note">{t('orchestra.noProducts')}</p>}
    {products.map((p) => (
      <label key={p.id} className="pt-field">
        <span title={p.folderPath}>{p.name}</span>
        <textarea className="st-textarea" rows={3} value={rules.products?.[p.id] ?? ''} placeholder={t('orchestra.productPlaceholder')} spellCheck={false}
          onChange={(e) => update({ ...rules, products: { ...rules.products, [p.id]: e.target.value } })} data-testid={`orchestra-product-${p.id}`} />
      </label>
    ))}
  </div>
}
