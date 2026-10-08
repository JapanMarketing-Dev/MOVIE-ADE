/**
 * 全体（すべてのプロダクト）で録った1回のフィードバックを、プロダクトごとに分ける。
 * 録画は止めずに帯のタブでプロダクトを切り替えるので、指摘ごとに「そのとき開いていたページ」の URL でプロダクトを決める。
 *   1. 登録した確認先の URL と同じページ・その下のページ（パスが続く）→ そのプロダクト（長く合うものを優先）
 *   2. 同じオリジンの確認先を持つプロダクトが1つだけ → そのプロダクト
 *   3. URL の無い指摘（ウインドウを映していたなど）・合わない指摘 → 直前の指摘と同じプロダクト（録画の時刻順）。最初なら決めない
 * 決まった指摘は、そのプロダクトに Agent が動いていればその Agent へ直接、居なければ全体の Agent がそのプロダクトの subagent に任せる。
 * どれも同時に（並行して）渡す。画面に依存しない純粋な処理だけを置く（送るのは src/main/index.ts の review:send）
 */

export interface SplitProject {
  id: string
  name: string
  folderPath: string
  urls: ReadonlyArray<{ url?: string }>
}

export interface SplitItem {
  /** 通し番号（feedback.md の見出しの番号） */
  index: number
  t: number
  url?: string
}

export interface ProductShare {
  /** 決まらなかった指摘は null */
  projectId: string | null
  indexes: number[]
}

function parse(url: string): URL | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

/** ページの URL がどのプロダクトのものか。決まらなければ null */
export function productForUrl(projects: readonly SplitProject[], url: string | undefined): string | null {
  const page = url ? parse(url) : null
  if (!page) return null
  let best: { id: string; length: number } | null = null
  for (const p of projects) {
    for (const target of p.urls) {
      const u = target.url ? parse(target.url) : null
      if (!u || u.origin !== page.origin) continue
      const base = u.pathname.replace(/\/+$/, '')
      const path = page.pathname.replace(/\/+$/, '')
      if (path === base || path.startsWith(`${base}/`) || base === '') {
        // パスが長く合うほど確か。ルート（/）だけの一致は同じオリジンのプロダクトが1つのときに限る
        if (base === '' && projects.filter((q) => q.urls.some((x) => x.url && parse(x.url)?.origin === page.origin)).length > 1) continue
        if (!best || base.length > best.length) best = { id: p.id, length: base.length }
      }
    }
  }
  return best?.id ?? null
}

/** 指摘をプロダクトごとに分ける。並びはプロダクトの登録順、決まらなかったものは最後 */
export function splitByProduct(projects: readonly SplitProject[], items: readonly SplitItem[]): ProductShare[] {
  const byProject = new Map<string | null, number[]>()
  let last: string | null = null
  for (const item of [...items].sort((a, b) => a.t - b.t)) {
    const own = productForUrl(projects, item.url)
    const id = own ?? (item.url && parse(item.url) ? null : last)
    if (own) last = own
    const list = byProject.get(id) ?? []
    list.push(item.index)
    byProject.set(id, list)
  }
  const order = [...projects.map((p) => p.id), null]
  return order.flatMap((id) => {
    const indexes = byProject.get(id)
    return indexes?.length ? [{ projectId: id, indexes: indexes.sort((a, b) => a - b) }] : []
  })
}

/** 番号の並び（#1, #3） */
export function itemList(indexes: readonly number[]): string {
  return indexes.map((i) => `#${i}`).join(', ')
}
