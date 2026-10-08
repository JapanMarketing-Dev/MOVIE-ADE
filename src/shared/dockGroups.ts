/**
 * 全体のフィードバックの帯のタブ（2段）。上の段はプロダクト、下の段はそのプロダクトの確認先（prd・local などの登録した URL）と、
 * 確認リスト（human.md の B1 など）のうちそのプロダクトのもの。画面に依存しない純粋な処理だけを置く（使うのは OrchestraDock）。
 *
 * - 確認リストの行は、同じ URL・オリジンが合うただ1つのプロダクト・名前が合うプロダクトの順で、そのプロダクトに入れる
 * - 登録した URL と同じ URL の行は1つにまとめる（下の段のタブに B1 の印を付ける）
 * - どのプロダクトにも合わない行は、行の名前ごとに上の段のタブを作る
 * - 上の段は、確認リストに出てくる順（B1 のプロダクトが先）→ 残りは登録の順
 */

export interface DockItem {
  /** 確認リストの番号（B1 など）。無ければ空 */
  key: string
  /** 下の段のタブの名前（prd・local など。確認リストだけの行は見てほしいことか URL） */
  label: string
  url: string
}

export interface DockGroup {
  id: string
  label: string
  items: DockItem[]
}

export interface DockProject {
  id: string
  name: string
  urls: ReadonlyArray<{ label: string; url?: string }>
}

export interface DockChecklistItem {
  key: string
  label: string
  url: string
  note: string
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s_\-・·]+/g, '')
}

export function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/$/, '') === b.replace(/\/$/, '')
}

export function groupDockTargets(projects: readonly DockProject[], checklist: readonly DockChecklistItem[]): DockGroup[] {
  const groups = new Map<string, DockGroup>()
  const order: string[] = []
  const touch = (id: string) => { if (!order.includes(id)) order.push(id) }
  for (const p of projects) {
    const items = p.urls.flatMap((u) => (u.url ? [{ key: '', label: u.label || u.url, url: u.url }] : []))
    groups.set(`p:${p.id}`, { id: `p:${p.id}`, label: p.name, items })
  }
  for (const c of checklist) {
    const origin = originOf(c.url)
    const name = normalize(c.label)
    const byName = (list: readonly DockProject[]) =>
      list.find((p) => name && (normalize(p.name) === name || name.includes(normalize(p.name)) || normalize(p.name).includes(name)))
    // 同じ URL → オリジンが1つのプロダクトだけに合う → 名前。同じオリジンのプロダクトが複数なら名前で選ぶ
    const sameOrigin = origin ? projects.filter((p) => p.urls.some((u) => u.url && originOf(u.url) === origin)) : []
    const owner = projects.find((p) => p.urls.some((u) => u.url && sameUrl(u.url, c.url)))
      ?? (sameOrigin.length === 1 ? sameOrigin[0] : byName(sameOrigin) ?? byName(projects))
    const id = owner ? `p:${owner.id}` : `c:${c.label || c.url}`
    let group = groups.get(id)
    if (!group) {
      group = { id, label: c.label || c.url, items: [] }
      groups.set(id, group)
    }
    touch(id)
    const same = group.items.find((i) => sameUrl(i.url, c.url))
    if (same) {
      if (!same.key) same.key = c.key
      continue
    }
    group.items.push({ key: c.key, label: c.note || c.label || c.url, url: c.url })
  }
  for (const p of projects) touch(`p:${p.id}`)
  return order.map((id) => groups.get(id)!).filter((g) => g.items.length > 0)
}

/** 開いているページがどのタブか（同じ URL を先に、無ければ同じオリジン） */
export function currentDockGroup(groups: readonly DockGroup[], url: string): string | null {
  const exact = groups.find((g) => g.items.some((i) => sameUrl(i.url, url)))
  if (exact) return exact.id
  const origin = originOf(url)
  return (origin && groups.find((g) => g.items.some((i) => originOf(i.url) === origin))?.id) ?? null
}
