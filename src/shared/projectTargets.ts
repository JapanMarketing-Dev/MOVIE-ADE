import type { CaptureSourceInfo, ProjectKind, ProjectTarget } from './types'

/**
 * プロジェクトの種類と確認先（ターゲット）の純粋な関数。main（設定の読み込み）と renderer（編集・ボタン）で共有する。
 *
 * 確認先は名前が自由で、件数の上限は無い。local / dev / prd は新しく足すときの名前の候補でしかない。
 * 種類によって確認先に入れるものが変わるが、データは種類を変えても失わないよう、どの種類でも全項目を保つ
 * （画面がその種類で使う欄だけを出す）。
 */

export const PROJECT_KINDS: readonly ProjectKind[] = ['web', 'mobile', 'desktop', 'other']
export const DEFAULT_PROJECT_KIND: ProjectKind = 'web'

/** 種類ごとに画面へ出す欄 */
export const KIND_FIELDS: Record<ProjectKind, { url: boolean; launchCommand: boolean; windowMatch: boolean }> = {
  web: { url: true, launchCommand: false, windowMatch: false },
  mobile: { url: true, launchCommand: true, windowMatch: true },
  desktop: { url: true, launchCommand: true, windowMatch: true },
  other: { url: true, launchCommand: true, windowMatch: true }
}

/** 新しく足すときの名前の候補（順に、まだ使っていないものを選ぶ） */
export const SUGGESTED_LABELS: Record<ProjectKind, readonly string[]> = {
  web: ['local', 'dev', 'prd', 'staging', 'preview'],
  mobile: ['iOS sim', 'Android emu', 'mobile web'],
  desktop: ['dev', 'app'],
  other: ['target']
}

/** 欄の入力例（placeholder） */
export const KIND_PLACEHOLDERS: Record<ProjectKind, { url: string; launchCommand: string; windowMatch: string }> = {
  web: { url: 'http://localhost:3000', launchCommand: '', windowMatch: '' },
  mobile: { url: 'http://localhost:8081', launchCommand: 'open -a Simulator', windowMatch: 'Simulator' },
  desktop: { url: 'http://localhost:1420', launchCommand: 'pnpm tauri dev', windowMatch: 'MyApp' },
  other: { url: 'http://localhost:3000', launchCommand: './run.sh', windowMatch: '' }
}

export function sanitizeProjectKind(raw: unknown): ProjectKind {
  return PROJECT_KINDS.includes(raw as ProjectKind) ? (raw as ProjectKind) : DEFAULT_PROJECT_KIND
}

const text = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** URL・起動コマンド・ウインドウのどれも無い確認先は、何もできないので捨てる */
export function hasTargetContent(target: Pick<ProjectTarget, 'url' | 'launchCommand' | 'windowMatch'>): boolean {
  return !!(target.url || target.launchCommand || target.windowMatch)
}

/**
 * 設定ファイルの確認先を型どおりに直す。
 * URL だけを持っていた頃の {id, label, url} はそのまま通る（移行で何も失わない）。
 * id が無いもの・重なるものには新しい id を振る。名前が無ければ中身から付ける。
 */
export function sanitizeProjectTargets(raw: unknown, newId: () => string = () => crypto.randomUUID()): ProjectTarget[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.flatMap((item): ProjectTarget[] => {
    if (!item || typeof item !== 'object') return []
    const r = item as Partial<Record<keyof ProjectTarget, unknown>>
    const url = text(r.url)
    const launchCommand = text(r.launchCommand)
    const windowMatch = text(r.windowMatch, 200)
    if (!url && !launchCommand && !windowMatch) return []
    let id = text(r.id, 200)
    if (!id || seen.has(id)) id = newId()
    seen.add(id)
    const label = text(r.label, 100) || url || windowMatch || launchCommand
    return [{ id, label, ...(url ? { url } : {}), ...(launchCommand ? { launchCommand } : {}), ...(windowMatch ? { windowMatch } : {}) }]
  })
}

/** まだ使っていない候補の名前。候補を使い切ったら「候補 2」「候補 3」… */
export function suggestTargetLabel(kind: ProjectKind, targets: readonly Pick<ProjectTarget, 'label'>[]): string {
  const used = new Set(targets.map((t) => t.label.trim().toLowerCase()))
  const candidates = SUGGESTED_LABELS[kind]
  const free = candidates.find((label) => !used.has(label.toLowerCase()))
  if (free) return free
  const base = candidates[0] ?? 'target'
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

/** 確認先を末尾に足す（編集中は中身が空でもよい。保存時の sanitize で空のものは落ちる） */
export function addTarget(targets: readonly ProjectTarget[], kind: ProjectKind, init: Partial<Omit<ProjectTarget, 'id'>> = {}, id: string = crypto.randomUUID()): ProjectTarget[] {
  return [...targets, { id, label: init.label ?? suggestTargetLabel(kind, targets), ...stripEmpty(init) }]
}

export function updateTarget(targets: readonly ProjectTarget[], id: string, patch: Partial<Omit<ProjectTarget, 'id'>>): ProjectTarget[] {
  return targets.map((t) => {
    if (t.id !== id) return t
    const merged: ProjectTarget = { ...t, ...patch }
    // 空にした欄は消す（設定ファイルに空文字を残さない）
    for (const key of ['url', 'launchCommand', 'windowMatch'] as const) if (!merged[key]?.trim()) delete merged[key]
    return merged
  })
}

export function removeTarget(targets: readonly ProjectTarget[], id: string): ProjectTarget[] {
  return targets.filter((t) => t.id !== id)
}

/** from の位置の確認先を to の位置へ動かす（範囲外は端に寄せる） */
export function moveTarget(targets: readonly ProjectTarget[], from: number, to: number): ProjectTarget[] {
  if (from < 0 || from >= targets.length) return [...targets]
  const list = [...targets]
  const [item] = list.splice(from, 1)
  list.splice(Math.max(0, Math.min(to, list.length)), 0, item!)
  return list
}

function stripEmpty(init: Partial<Omit<ProjectTarget, 'id'>>): Partial<ProjectTarget> {
  const out: Partial<ProjectTarget> = {}
  for (const key of ['url', 'launchCommand', 'windowMatch'] as const) if (init[key]?.trim()) out[key] = init[key]!.trim()
  return out
}

/** URL を持つ確認先だけ（内蔵ブラウザで開けるもの） */
export function urlTargets<T extends ProjectTarget>(targets: readonly T[]): Array<T & { url: string }> {
  return targets.filter((t): t is T & { url: string } => !!t.url)
}

/**
 * 確認先のボタンを押したときにすること。
 *   url    … URL を内蔵ブラウザで開く
 *   window … 起動コマンドがあればターミナルで走らせ、ウインドウを録画の対象に選ぶ（URL もあれば開く）
 *   none   … 何もできない（書きかけ）
 * web のプロジェクトは常に URL として扱う（起動コマンドやウインドウの欄を出していないため）。
 */
export type TargetAction =
  | { kind: 'url'; url: string }
  | { kind: 'window'; launchCommand?: string; windowMatch?: string; url?: string }
  | { kind: 'none' }

export function targetAction(target: ProjectTarget, projectKind: ProjectKind = DEFAULT_PROJECT_KIND): TargetAction {
  const fields = KIND_FIELDS[projectKind]
  const launchCommand = fields.launchCommand ? target.launchCommand : undefined
  const windowMatch = fields.windowMatch ? target.windowMatch : undefined
  if (launchCommand || windowMatch) {
    return { kind: 'window', ...(launchCommand ? { launchCommand } : {}), ...(windowMatch ? { windowMatch } : {}), ...(target.url ? { url: target.url } : {}) }
  }
  if (target.url) return { kind: 'url', url: target.url }
  return { kind: 'none' }
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase().trim()

/**
 * 録画の対象の一覧から、ウインドウの名前に合うものを選ぶ（画面全体は選ばない）。
 * 完全一致 → 前方一致 → 部分一致 の順に、より短い名前（＝余計な語の少ないもの）を選ぶ。
 * macOS のウインドウ名は「アプリ名 - 文書名」の形が多いので、部分一致まで見る。
 */
export function matchWindowSource(sources: readonly CaptureSourceInfo[], match: string | undefined): CaptureSourceInfo | null {
  const want = norm(match ?? '')
  if (!want) return null
  const windows = sources.filter((s) => s.kind === 'window')
  const score = (name: string): number => {
    const n = norm(name)
    if (n === want) return 0
    if (n.startsWith(want)) return 1
    if (n.includes(want)) return 2
    return -1
  }
  let best: { source: CaptureSourceInfo; score: number } | null = null
  for (const source of windows) {
    const s = score(source.name)
    if (s < 0) continue
    if (!best || s < best.score || (s === best.score && source.name.length < best.source.name.length)) best = { source, score: s }
  }
  return best?.source ?? null
}
