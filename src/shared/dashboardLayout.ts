/**
 * オーケストラのダッシュボードの中身を利用者（と Agent）が JSON で決める。置き場はオーケストラのフォルダの `.ferret/dashboard.json`。
 * 無ければ今までの並び（DEFAULT_SECTIONS）。ferret-settings skill で Agent が作り・直す（src/shared/agentSkill.ts）。
 *
 *   { "sections": [
 *       { "type": "checklist" },
 *       { "type": "metrics", "title": "今週", "items": [{ "label": "売上", "value": "¥120,000", "hint": "先週比 +8%" }] },
 *       { "type": "note", "title": "今日の方針", "file": "notes/today.md" },
 *       { "type": "links", "title": "管理画面", "items": [{ "label": "Stripe", "url": "https://dashboard.stripe.com" }] },
 *       { "type": "table", "title": "リリース", "columns": ["製品", "版"], "rows": [["shop", "1.2.0"]] },
 *       { "type": "projects" }, { "type": "costs" }
 *   ] }
 *
 * 組み込みの部品（Ferret が中身を作る）: checklist・stats・composer・actions・requests・projects・costs。
 * 自由な部品（中身を JSON に書く）: metrics・note（オーケストラのフォルダの中のテキストファイルをそのまま文字で出す）・links（https だけ）・table。
 * HTML やスクリプトは出さない（文字として出す）。画面に依存しない純粋な処理だけを置く
 */

export const BUILTIN_SECTIONS = ['checklist', 'stats', 'composer', 'actions', 'requests', 'projects', 'costs'] as const
export type BuiltinSection = (typeof BUILTIN_SECTIONS)[number]

export type DashboardSection =
  | { type: BuiltinSection; title?: string }
  | { type: 'metrics'; title?: string; items: Array<{ label: string; value: string; hint?: string }> }
  | { type: 'note'; title?: string; file: string }
  | { type: 'links'; title?: string; items: Array<{ label: string; url: string }> }
  | { type: 'table'; title?: string; columns: string[]; rows: string[][] }

export const DEFAULT_SECTIONS: DashboardSection[] = BUILTIN_SECTIONS.map((type) => ({ type }))

/** 読んだダッシュボード。note はファイルの中身を添える（読めなければ null） */
export interface DashboardLayout {
  sections: DashboardSection[]
  /** note の file → 中身 */
  notes: Record<string, string | null>
  /** dashboard.json が壊れていた（今までの並びで出している） */
  invalid?: boolean
  /** dashboard.json があった */
  custom: boolean
}

const MAX_SECTIONS = 40
const MAX_ITEMS = 50
const MAX_ROWS = 200
const MAX_COLUMNS = 12
export const MAX_NOTE_BYTES = 200 * 1024

function text(v: unknown, max: number): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v).slice(0, max)
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) : ''
}

function title(v: unknown): { title?: string } {
  const t = text(v, 80)
  return t ? { title: t } : {}
}

function isHttps(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && !u.username && !u.password && !!u.hostname
  } catch {
    return false
  }
}

/**
 * note の file：オーケストラのフォルダからの相対パスだけ（絶対パス・.. で外へ出る・ドライブ名・バックスラッシュは断る）。
 * 正規化した相対パスを返す。だめなら null
 */
export function safeNotePath(file: unknown): string | null {
  if (typeof file !== 'string') return null
  const raw = file.trim()
  if (!raw || raw.length > 300 || raw.startsWith('/') || raw.includes('\\') || /^[A-Za-z]:/.test(raw) || raw.includes('\0')) return null
  const parts: string[] = []
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') return null
    parts.push(part)
  }
  return parts.length ? parts.join('/') : null
}

/** dashboard.json の中身を確かめる。知らない部品・壊れた部品は捨てる。部品が1つも残らなければ null（今までの並び） */
export function parseDashboard(raw: unknown): DashboardSection[] | null {
  const list = raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray((raw as { sections?: unknown }).sections)
    ? (raw as { sections: unknown[] }).sections
    : Array.isArray(raw) ? raw : null
  if (!list) return null
  const out = list.slice(0, MAX_SECTIONS).flatMap((item): DashboardSection[] => {
    if (!item || typeof item !== 'object') return []
    const s = item as Record<string, unknown>
    const type = s.type
    if ((BUILTIN_SECTIONS as readonly unknown[]).includes(type)) return [{ type: type as BuiltinSection, ...title(s.title) }]
    if (type === 'metrics' && Array.isArray(s.items)) {
      const items = s.items.slice(0, MAX_ITEMS).flatMap((m) => {
        if (!m || typeof m !== 'object') return []
        const r = m as Record<string, unknown>
        const label = text(r.label, 80)
        const value = text(r.value, 80)
        const hint = text(r.hint, 160)
        return label && value ? [{ label, value, ...(hint ? { hint } : {}) }] : []
      })
      return items.length ? [{ type, ...title(s.title), items }] : []
    }
    if (type === 'note') {
      const file = safeNotePath(s.file)
      return file ? [{ type, ...title(s.title), file }] : []
    }
    if (type === 'links' && Array.isArray(s.items)) {
      const items = s.items.slice(0, MAX_ITEMS).flatMap((l) => {
        if (!l || typeof l !== 'object') return []
        const r = l as Record<string, unknown>
        const url = text(r.url, 2000)
        const label = text(r.label, 80) || url
        return url && isHttps(url) ? [{ label, url }] : []
      })
      return items.length ? [{ type, ...title(s.title), items }] : []
    }
    if (type === 'table' && Array.isArray(s.columns) && Array.isArray(s.rows)) {
      const columns = s.columns.slice(0, MAX_COLUMNS).map((c) => text(c, 80))
      if (!columns.length) return []
      const rows = s.rows.slice(0, MAX_ROWS).flatMap((r) => (Array.isArray(r) ? [columns.map((_, i) => text(r[i], 400))] : []))
      return [{ type, ...title(s.title), columns, rows }]
    }
    return []
  })
  return out.length ? out : null
}
