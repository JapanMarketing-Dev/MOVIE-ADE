import { isLocalDevUrl, matchPresetUrl } from './projectUrl'
import { previewPathFromUrl } from './preview'

/**
 * 指摘を直したあとの画面（AFTER のスクリーンショット）。
 *
 * Ferret は直ったかを判定しない。Agent が直したら、手元の開発サーバー（localhost）で同じページ・同じ幅を撮り、
 * レビューのフォルダの after/<指摘ID>.png に置いて、progress.json の after に書く。Findings のカードは
 * 録画時の静止画（BEFORE）と並べて見せ、人が一目で直ったか分かるようにする。
 * 判定モデルが有効なら、同じ AFTER を判定にも使う（別の画像は撮らせない）。
 *
 * main（feedback.md・画像の読み込み）と renderer（カード）の両方が読む純粋な処理だけを置く。
 */

/** レビューのフォルダの中の、AFTER を置くフォルダ */
const AFTER_DIR = 'after'

/** 撮る画面の大きさの既定値（録画時の幅が分からないとき） */
const DEFAULT_AFTER_VIEWPORT = { width: 1280, height: 800 } as const

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i

/** 指摘のIDをファイル名に使える形にする（ID は i1 のような英数字だが、念のため） */
function fileSafeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'finding'
}

/** その指摘の AFTER を置く場所（レビューのフォルダからの相対パス） */
export function afterRelPath(id: string): string {
  return `${AFTER_DIR}/${fileSafeId(id)}.png`
}

/**
 * progress.json の after を読む。レビューのフォルダの中を指す画像の相対パスだけを受け付ける。
 * 絶対パス・ドライブ文字・..・空の区切り・バックスラッシュは捨てる（Agent が書くので崩れることがある）
 */
export function sanitizeAfterPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  let path = raw.trim()
  if (!path || path.length > 200 || path.includes('\\') || path.includes('\0')) return undefined
  if (path.startsWith('./')) path = path.slice(2)
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) return undefined
  const parts = path.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return undefined
  return IMAGE_EXT.test(path) ? path : undefined
}

/**
 * 指摘の URL を、手元の開発サーバー（確認先の local）の URL に置き換える。
 * - もともと localhost なら、そのまま
 * - 録画時の確認先（local / dev / prd）が分かれば、その確認先のパスからの続きを local の URL に足す
 * - 当たる確認先が無ければ、パス・クエリ・アンカーをそのまま local のオリジンに付ける
 * local の確認先が登録されていなければ null（Agent が自分で開発サーバーを起動して同じパスを開く）
 */
export function localTargetUrl(url: string, presets: ReadonlyArray<{ label: string; url?: string }>): string | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null } // 読めない URL は置き換えない（想定内）
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (isLocalDevUrl(url)) return url
  const local = presets.find((p) => p.url && isLocalDevUrl(p.url))
  if (!local?.url) return null
  const localBase = new URL(local.url)
  const matched = matchPresetUrl(presets.map((p, i) => ({ id: String(i), ...p })), url)
  let rest = `${parsed.pathname}${parsed.search}${parsed.hash}`
  if (matched?.url) {
    const base = new URL(matched.url).pathname.replace(/\/+$/, '')
    if (base && parsed.pathname.startsWith(base)) rest = `${parsed.pathname.slice(base.length) || '/'}${parsed.search}${parsed.hash}`
  }
  const prefix = localBase.pathname.replace(/\/+$/, '')
  return `${localBase.origin}${prefix}${rest.startsWith('/') ? rest : `/${rest}`}`
}

interface AfterCaptureSpec {
  /** 撮る URL（local に置き換えたもの）。local が分からなければ null */
  url: string | null
  /** 録画したときの URL（local が分からないとき、このパスを開発サーバーで開く） */
  sourceUrl: string
  width: number
  height: number
  /** レビューのフォルダからの相対パス（progress.json の after に書く値） */
  relPath: string
}

/**
 * 指摘ごとの撮り方。URL の指摘だけ（ファイルのプレビュー ade-preview:// や対象なしは null）。
 * 幅は録画時の表示幅、高さは BEFORE と比べやすい既定の高さ
 */
export function afterCaptureSpec(item: { id: string; context: { url?: string; viewport?: number } }, presets: ReadonlyArray<{ label: string; url?: string }>): AfterCaptureSpec | null {
  const sourceUrl = item.context.url
  if (!sourceUrl || previewPathFromUrl(sourceUrl) || !/^https?:/i.test(sourceUrl)) return null
  const width = item.context.viewport && item.context.viewport >= 320 && item.context.viewport <= 3840 ? Math.round(item.context.viewport) : DEFAULT_AFTER_VIEWPORT.width
  return { url: localTargetUrl(sourceUrl, presets), sourceUrl, width, height: DEFAULT_AFTER_VIEWPORT.height, relPath: afterRelPath(item.id) }
}

/** Agent に依らない撮り方の例（Playwright の CLI）。パスと URL は引用符で囲む */
export function afterCommand(url: string, width: number, height: number, outPath: string): string {
  return `npx --yes playwright screenshot --viewport-size=${width},${height} "${url}" "${outPath}"`
}

/** カードに出す画像の判定。done なのに AFTER が無ければ「AFTER がありません」を出す */
export function cardShots(opt: { before?: string; after?: string; progress: string }): { before?: string; after?: string; missingAfter: boolean; compare: boolean } {
  return {
    ...(opt.before ? { before: opt.before } : {}),
    ...(opt.after ? { after: opt.after } : {}),
    missingAfter: opt.progress === 'done' && !opt.after,
    compare: !!opt.before && !!opt.after
  }
}

/** 判定モデルのスコア（判定モデルが有効なとき、Agent が progress.json の score に書く。人の判断の材料） */
export interface DecisionScore {
  /** done の P(true) */
  noul: number
  choice?: 'done' | 'partial' | 'not_done' | 'cannot_tell'
  confidence?: number
  /** 判定した回数 */
  rounds?: number
}

const prob = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

/** progress.json の score を読む。noul が読めなければ無し（Agent が書くので崩れることがある） */
export function sanitizeDecisionScore(raw: unknown): DecisionScore | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (!prob(r.noul)) return undefined
  const choice = r.choice === 'done' || r.choice === 'partial' || r.choice === 'not_done' || r.choice === 'cannot_tell' ? r.choice : undefined
  const rounds = typeof r.rounds === 'number' && Number.isInteger(r.rounds) && r.rounds >= 1 && r.rounds <= 1000 ? r.rounds : undefined
  return { noul: r.noul, ...(choice ? { choice } : {}), ...(prob(r.confidence) ? { confidence: r.confidence } : {}), ...(rounds ? { rounds } : {}) }
}

/** カードに出す短い形（例「0.92 · done · conf 0.66 · 2 rounds」の材料）。数は小数2桁 */
function scoreParts(score: DecisionScore): { noul: string; choice?: string; confidence?: string; rounds?: number } {
  return { noul: score.noul.toFixed(2), ...(score.choice ? { choice: score.choice } : {}), ...(score.confidence !== undefined ? { confidence: score.confidence.toFixed(2) } : {}), ...(score.rounds ? { rounds: score.rounds } : {}) }
}

/** 画面で AFTER を読む URL（main の ade-media が中を確かめて返す）。v は読み直し用 */
export function afterImageUrl(reviewId: string, rel: string, version: number | string): string {
  return `ade-media://review/${reviewId}/file/${rel.split('/').map(encodeURIComponent).join('/')}?v=${encodeURIComponent(String(version))}`
}

type ScoreTranslate = (key: 'review.shots.judged' | 'review.shots.judgedNoChoice' | 'review.shots.confidence' | 'review.shots.rounds' | `review.shots.choice.${NonNullable<DecisionScore['choice']>}`, params?: Record<string, string | number>) => string

/**
 * カードの点数の行（例「判定: 合格 0.92 · 確信 0.66 · 2回」）。判定モデルの見立てだと分かる書き方にする
 * （人が付ける done と紛らわしくならないよう、選択肢の done は「合格」と書く）
 */
export function scoreSummary(score: DecisionScore, t: ScoreTranslate): string {
  const parts = scoreParts(score)
  return [
    parts.choice ? t('review.shots.judged', { choice: t(`review.shots.choice.${score.choice!}`), noul: parts.noul }) : t('review.shots.judgedNoChoice', { noul: parts.noul }),
    parts.confidence !== undefined ? t('review.shots.confidence', { value: parts.confidence }) : null,
    parts.rounds ? t('review.shots.rounds', { count: parts.rounds }) : null
  ].filter(Boolean).join(' · ')
}
