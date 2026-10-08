/**
 * 人の確認リスト（全体のフォルダの human.md）。全体の Agent が「人が確かめること」をプロダクト・URL・見てほしいことの形で書き、
 * 人はそれを上から順に開いて、1回のフィードバックで全部のプロダクトを確かめる（録画を止めずにページを切り替える）。
 * Markdown の表の行・箇条書きのうち、http(s) の URL を含むものを1件にする。画面に依存しない純粋な処理だけを置く
 */

export interface ChecklistItem {
  /** 行の見出し（表の最初の列や箇条書きの先頭。例 B1） */
  key: string
  /** プロダクトの名前など（URL の前の列） */
  label: string
  url: string
  /** 見てほしいこと（URL の後ろの列・文） */
  note: string
}

const URL_RE = /https?:\/\/[^\s)|>\]]+/
const MAX_ITEMS = 200

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
  for (const raw of markdown.split(/\r?\n/)) {
    if (items.length >= MAX_ITEMS) break
    const line = raw.trim()
    if (!line || /^\|?\s*:?-{2,}/.test(line)) continue
    // 表の行：| B1 | 営業企業DB | https://... | 見てほしいこと |
    if (line.startsWith('|')) {
      const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const at = cells.findIndex((c) => urlIn(c) !== null)
      if (at < 0) continue
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
    if (!url) continue
    const [head, ...rest] = body.split(url)
    n += 1
    items.push({ key: String(n), label: plain((head ?? '').replace(/\[([^\]]*)\]\($/, '$1').replace(/[:：\-–(（]\s*$/, '')), url, note: plain(rest.join(' ').replace(/^\)/, '')) })
  }
  return items
}

/** 同じ URL は1件にする（最初のものを残す） */
export function uniqueByUrl(items: readonly ChecklistItem[]): ChecklistItem[] {
  const seen = new Set<string>()
  return items.filter((it) => (seen.has(it.url) ? false : (seen.add(it.url), true)))
}
