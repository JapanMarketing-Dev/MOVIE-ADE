/**
 * 人の確認リスト（全体のフォルダの human.md）。全体の Agent が「人が確かめること」をプロダクト・URL・見てほしいことの形で書き、
 * 人はそれを上から順に開いて、1回のフィードバックで全部のプロダクトを確かめる（録画を止めずにページを切り替える）。
 * Markdown の表の行・箇条書きのうち、http(s) の URL を含むものを1件にする。
 * URL の無いもの（承認・人が用意するもの・決めること）も、番号（B1・A2・P1・D1 など）で始まる表の行と、未チェックの - [ ] は1件にする
 * （url は空。ダッシュボードの一番上に全部出し、ページを開く巡回には入れない）。画面に依存しない純粋な処理だけを置く
 */

export interface ChecklistItem {
  /** 行の見出し（表の最初の列や箇条書きの先頭。例 B1） */
  key: string
  /** プロダクトの名前など（URL の前の列） */
  label: string
  /** 開くページ。URL の無い項目（承認・用意・決めること）は空 */
  url: string
  /** 見てほしいこと（URL の後ろの列・文） */
  note: string
}

const URL_RE = /https?:\/\/[^\s)|>\]]+/
const MAX_ITEMS = 200
/** URL の無い表の行を項目にするときの番号（B1・A2・P10 など） */
const KEY_RE = /^[A-Z]{1,2}\d{1,3}$/
const NO_URL = /^[-–—]?$/

function plain(text: string): string {
  let out = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[*_`~]/g, '')
  // タグは外すと新しいタグができることがあるので、変わらなくなるまで繰り返す
  let prev: string
  do {
    prev = out
    out = out.replace(/<[^>]*>/g, '')
  } while (out !== prev)
  return out.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()
}

function urlIn(text: string): string | null {
  const link = /\]\((https?:\/\/[^)\s]+)\)/.exec(text)
  if (link) return link[1]!
  const bare = URL_RE.exec(text)
  return bare ? bare[0].replace(/[.,;:]+$/, '') : null
}

export function parseHumanChecklist(markdown: string): ChecklistItem[] {
  const items: ChecklistItem[] = []
  let n = 0
  const lines = markdown.split(/\r?\n/)
  for (const [index, raw] of lines.entries()) {
    if (items.length >= MAX_ITEMS) break
    const line = raw.trim()
    if (!line || /^\|?\s*:?-{2,}/.test(line)) continue
    // 表の行：| B1 | 営業企業DB | https://... | 見てほしいこと |
    if (line.startsWith('|')) {
      // 見出しの行（次の行が区切り）は飛ばす
      if (/^\|?\s*:?-{2,}/.test(lines[index + 1]?.trim() ?? '')) continue
      const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const at = cells.findIndex((c) => urlIn(c) !== null)
      if (at < 0) {
        // URL の無い項目：| A1 | 営業企業DB | - | 本番の DB の削除を承認 |
        const key = plain(cells[0] ?? '')
        if (!KEY_RE.test(key)) continue
        const rest = cells.slice(1).map(plain)
        const gap = rest.findIndex((c) => NO_URL.test(c))
        const label = gap > 0 ? rest.slice(0, gap).filter(Boolean).join(' ') : rest.length > 1 ? rest[0]! : ''
        const note = (gap >= 0 ? rest.slice(gap + 1) : rest.length > 1 ? rest.slice(1) : rest).filter(Boolean).join(' / ')
        n += 1
        items.push({ key, label, url: '', note })
        continue
      }
      const url = urlIn(cells[at]!)!
      const before = cells.slice(0, at).map(plain).filter(Boolean)
      const after = cells.slice(at + 1).map(plain).filter(Boolean)
      n += 1
      items.push({ key: before.length > 1 ? before[0]! : String(n), label: before.length > 1 ? before.slice(1).join(' ') : before[0] ?? '', url, note: after.join(' / ') })
      continue
    }
    // 箇条書き：- [ ] 営業企業DB https://... 検索の速さ
    const bullet = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line)
    if (!bullet) continue
    const body = bullet[1]!
    const url = urlIn(body)
    if (!url) {
      // URL の無い箇条書きは、未チェックの - [ ] だけを項目にする（説明の箇条書きは拾わない）
      if (!/^(?:[-*+]|\d+[.)])\s+\[ \]\s+/.test(line) || !plain(body).length) continue
      n += 1
      items.push({ key: String(n), label: '', url: '', note: plain(body) })
      continue
    }
    const [head, ...rest] = body.split(url)
    n += 1
    items.push({ key: String(n), label: plain((head ?? '').replace(/\[([^\]]*)\]\($/, '$1').replace(/[:：\-–(（]\s*$/, '')), url, note: plain(rest.join(' ').replace(/^\)/, '')) })
  }
  return items
}

/** 同じ URL は1件にする（最初のものを残す）。URL の無い項目はそのまま残す */
export function uniqueByUrl(items: readonly ChecklistItem[]): ChecklistItem[] {
  const seen = new Set<string>()
  return items.filter((it) => (!it.url ? true : seen.has(it.url) ? false : (seen.add(it.url), true)))
}

/** ページを開いて確かめる項目（URL のあるもの）。確認リストの巡回と全体のフィードバックの帯に使う */
export function pageItems<T extends { url: string }>(items: readonly T[]): T[] {
  return items.filter((it) => !!it.url)
}
