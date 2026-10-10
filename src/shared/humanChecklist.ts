/**
 * 人の確認リスト（全体のフォルダの human.md）。全体の Agent が「人が確かめること」をプロダクト・URL・見てほしいことの形で書き、
 * 人はそれを上から順に開いて、1回のフィードバックで全部のプロダクトを確かめる（録画を止めずにページを切り替える）。
 * Markdown の表の行・箇条書きのうち、http(s) の URL を含むものを1件にする。
 * URL の無いもの（承認・人が用意するもの・決めること）も、番号（B1・A2・P1・D1 など）で始まる表の行と、未チェックの - [ ] は1件にする
 * （url は空。ダッシュボードの一番上に全部出し、ページを開く巡回には入れない）。画面に依存しない純粋な処理だけを置く
 *
 * 人に聞きたいことは質問のブロックにする（Claude Code の質問と同じく、番号の選択肢とおすすめ・自由入力）:
 *   ### Q1 [営業企業DB] 料金プランの形は？
 *   補足の説明（任意）
 *   1. 月額だけ
 *   2. 月額と年額 (recommended)
 * おすすめの選択肢は一番上に並べ替えて 1 番にする。表の行と同じ番号の質問のブロックは、その行の選択肢になる。
 * 番号は B1・P12 のほか DESIGN-6・NY-2 の形も使える。
 * 人の答えはファイルの最後の「## 回答」（## Answers）に `- Q1: 1. 月額と年額 — 補足` の形で Ferret が書く（setAnswers）。
 * どの項目にも答えられ、ダッシュボードから答えをまとめて Agent に送る（composeAnswersMessage。プロダクトごとにまとめる）
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
  /** 質問のブロックの選択肢（番号は 1 から） */
  options?: ChecklistOption[]
  /** 人の答え（human.md の「## 回答」の行） */
  answer?: string
}

export interface ChecklistOption {
  n: number
  text: string
  recommended: boolean
}

const URL_RE = /https?:\/\/[^\s)|>\]]+/
const MAX_ITEMS = 200
/** 項目の番号（B1・A2・P10・DESIGN-6・NY-2 など。大文字で始まり数字で終わる） */
const KEY_SRC = '[A-Z][A-Z0-9]{0,9}-?\\d{1,3}'
const KEY_RE = new RegExp(`^${KEY_SRC}$`)
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

const HEADING_RE = /^#{1,6}\s+(.*)$/
const ANSWERS_HEADING = /^#{1,6}\s+(?:回答|answers?)\s*(?:[（(].*)?$/i
const ANSWER_LINE = new RegExp(`^[-*+]\\s+(${KEY_SRC})\\s*[:：]\\s*(.*)$`)
const OPTION_RE = /^(\d{1,2})[.)]\s+(.+)$/
const RECOMMENDED_MARK = /\s*(?:[(（\[]\s*(?:recommended|おすすめ|推奨)\s*[)）\]]|★)\s*/i
const RECOMMEND_LINE = /^(?:おすすめ|推奨|recommended)\s*[:：]\s*(\d{1,2})\b/i
const MAX_ANSWER = 2000

/** 質問のブロックの見出し（### Q1 [プロダクト] 質問）。番号で始まらない見出しは null */
function questionHead(line: string): { key: string; label: string; title: string } | null {
  const h = HEADING_RE.exec(line)
  if (!h) return null
  const m = new RegExp(`^(${KEY_SRC})[.:：]?\\s+(.*)$`).exec(plain(h[1]!))
  if (!m || !KEY_RE.test(m[1]!)) return null
  const product = /^\[([^\]]+)\]\s*(.*)$/.exec(m[2]!)
  return { key: m[1]!, label: product ? product[1]!.trim() : '', title: (product ? product[2]! : m[2]!).trim() }
}

/** human.md の「## 回答」の行（キー → 答え）。後の行が勝つ */
export function parseAnswers(markdown: string): Record<string, string> {
  const out: Record<string, string> = {}
  let inside = false
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    if (HEADING_RE.test(line)) { inside = ANSWERS_HEADING.test(line); continue }
    if (!inside) continue
    const m = ANSWER_LINE.exec(line)
    if (m && m[2]!.trim()) out[m[1]!] = m[2]!.trim()
  }
  return out
}

export function parseHumanChecklist(markdown: string): ChecklistItem[] {
  const items: ChecklistItem[] = []
  let n = 0
  const lines = markdown.split(/\r?\n/)
  const answers = parseAnswers(markdown)
  let inAnswers = false
  let question: ChecklistItem | null = null
  const flush = () => {
    if (!question) return
    const q = question as ChecklistItem & { recommendedAt?: number }
    if (q.recommendedAt) for (const o of q.options ?? []) o.recommended = o.n === q.recommendedAt
    delete q.recommendedAt
    if (q.options?.length) q.options = recommendedFirst(q.options)
    else delete q.options
    // 表の行と同じ番号なら、その行の選択肢・補足にする（行の URL・プロダクトはそのまま）
    const row = items.find((it) => it.key === q.key && !it.options)
    if (row) {
      if (q.options) row.options = q.options
      if (!row.label && q.label) row.label = q.label
      if (q.note && q.note !== row.note) row.note = row.note ? `${row.note} / ${q.note}` : q.note
      if (!row.url && q.url) row.url = q.url
    } else {
      items.push(q)
    }
    question = null
  }
  for (const [index, raw] of lines.entries()) {
    if (items.length >= MAX_ITEMS) break
    const line = raw.trim()
    if (HEADING_RE.test(line)) {
      flush()
      inAnswers = ANSWERS_HEADING.test(line)
      const head = inAnswers ? null : questionHead(line)
      if (head) {
        n += 1
        question = { key: head.key, label: head.label, url: '', note: head.title, options: [] }
      }
      continue
    }
    // 回答の欄は人の答え。項目にはしない
    if (inAnswers) continue
    if (question) {
      // 質問のブロックの中：番号の行は選択肢、おすすめ: 2 はおすすめ、ほかは補足
      if (!line) continue
      if (line.startsWith('|') || /^-{3,}$/.test(line)) { flush() } else {
        const q: ChecklistItem = question
        const opt = OPTION_RE.exec(line)
        const rec = RECOMMEND_LINE.exec(line)
        if (opt && q.options!.length < 9) {
          const text = opt[2]!
          const recommended = RECOMMENDED_MARK.test(text)
          q.options!.push({ n: q.options!.length + 1, text: plain(text.replace(RECOMMENDED_MARK, ' ')), recommended })
        } else if (rec) {
          const at = Number(rec[1])
          ;(q as ChecklistItem & { recommendedAt?: number }).recommendedAt = at
        } else {
          const url = urlIn(line)
          if (url && !q.url) q.url = url
          const extra = plain(url ? line.replace(url, '') : line).replace(/^[-*+]\s+/, '')
          if (extra) q.note = q.note ? `${q.note} / ${extra}` : extra
        }
        continue
      }
    }
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
  flush()
  return items.slice(0, MAX_ITEMS).map((it) => (answers[it.key] ? { ...it, answer: answers[it.key] } : it))
}

/** おすすめの選択肢を一番上にし、番号を 1 から振り直す */
function recommendedFirst(options: readonly ChecklistOption[]): ChecklistOption[] {
  const sorted = [...options.filter((o) => o.recommended), ...options.filter((o) => !o.recommended)]
  return sorted.map((o, i) => ({ ...o, n: i + 1 }))
}

/** 答えを1行にする（改行・制御文字を除き、長さを切る）。空なら答えを消す */
export function cleanAnswer(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ANSWER)
}

export function isChecklistKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_RE.test(key)
}

/**
 * human.md の「## 回答」に答えを書く（無ければ最後に足す）。answer が空ならその行を消す。
 * Agent が書いた項目の部分には触らない
 */
export function setAnswers(markdown: string, entries: ReadonlyArray<{ key: string; answer: string }>, lang: 'ja' | 'en'): string {
  const wanted = new Map<string, string>()
  for (const e of entries) if (isChecklistKey(e.key)) wanted.set(e.key, cleanAnswer(e.answer))
  if (!wanted.size) return markdown
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
  const lines = markdown.split(/\r?\n/)
  let start = -1
  let end = lines.length
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim()
    if (!HEADING_RE.test(line)) continue
    if (start < 0 && ANSWERS_HEADING.test(line)) start = i
    else if (start >= 0) { end = i; break }
  }
  if (start < 0) {
    const adds = [...wanted].filter(([, a]) => a)
    if (!adds.length) return markdown
    const body = markdown.replace(/\s*$/, '')
    return `${body}${body ? `${eol}${eol}` : ''}${lang === 'ja' ? '## 回答' : '## Answers'}${eol}${eol}${adds.map(([k, a]) => `- ${k}: ${a}`).join(eol)}${eol}`
  }
  const section = lines.slice(start + 1, end)
  const kept: string[] = []
  for (const raw of section) {
    const m = ANSWER_LINE.exec(raw.trim())
    if (m && wanted.has(m[1]!)) {
      const a = wanted.get(m[1]!)!
      wanted.delete(m[1]!)
      if (a) kept.push(`- ${m[1]}: ${a}`)
      continue
    }
    kept.push(raw)
  }
  while (kept.length && !kept[0]!.trim()) kept.shift()
  while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop()
  const body = [...kept, ...[...wanted].filter(([, a]) => a).map(([k, a]) => `- ${k}: ${a}`)]
  const tail = lines.slice(end)
  return [...lines.slice(0, start + 1), ...(body.length ? ['', ...body] : []), '', ...tail].join(eol)
}

/** 選んだ選択肢と補足の区切り */
const NOTE_SEP = ' — '

/** 答えを選択肢の部分（`1. 月額と年額`）と補足に分ける。選択肢でなければ全体が自由な答え */
function splitAnswer(answer: string): { n: number; text: string; note: string } | null {
  const m = /^(\d{1,2})\.\s+(.*)$/.exec(answer)
  if (!m) return null
  const at = m[2]!.indexOf(NOTE_SEP)
  return { n: Number(m[1]), text: (at < 0 ? m[2]! : m[2]!.slice(0, at)).trim(), note: at < 0 ? '' : m[2]!.slice(at + NOTE_SEP.length).trim() }
}

/** 選択肢の答えの番号。文が同じ選択肢を先に探し（並べ替えた後も合うように）、無ければ番号で。自由入力なら null */
export function answerOption(item: Pick<ChecklistItem, 'options'>, answer: string | undefined): number | null {
  const a = splitAnswer(answer ?? '')
  if (!a) return null
  const byText = item.options?.find((o) => o.text === a.text)
  if (byText) return byText.n
  return item.options?.some((o) => o.n === a.n) ? a.n : null
}

/** 答えの補足（選択肢に足した自由な文）。選択肢の答えでなければ空 */
export function answerNote(item: Pick<ChecklistItem, 'options'>, answer: string | undefined): string {
  return answerOption(item, answer) === null ? '' : splitAnswer(answer!)!.note
}

/** 選んだ選択肢を答えの形にする（番号と文を両方残し、Agent が取り違えないように）。補足があれば後ろに足す */
export function optionAnswer(option: ChecklistOption, note = ''): string {
  const extra = note.trim()
  return `${option.n}. ${option.text}${extra ? `${NOTE_SEP}${extra}` : ''}`
}

/**
 * 答えた項目をまとめて全体の Agent に送る文。全体で人の確認なしで進めてよい操作も添える。
 * 送れる長さ（8000 文字）に収め、入りきらない分は human.md の「## 回答」を読むよう書く
 */
export function composeAnswersMessage(items: readonly ChecklistItem[], lang: 'ja' | 'en', allowed?: string): string {
  const answered = items.filter((it) => it.answer)
  const ja = lang === 'ja'
  const head = ja
    ? [
        '人が human.md の確認リストに答えました。下の答えに従って、すべてのプロダクトを同時に進めてください。',
        'プロダクトごとの subagent に任せ、互いに関係しないプロダクトは1つずつではなく並行して（Task をまとめて1回で）動かしてください。ブラウザの操作（Claude in Chrome など）も各 subagent が自分のタブで同時に行ってください。',
        '片付いた項目は human.md から消し、「## 回答」の同じ番号の行も消してください。答えから新しく人に確かめることが出たら、質問のブロック（選択肢とおすすめ付き）で human.md に足してください。'
      ]
    : [
        'A person answered the checklist in human.md. Act on the answers below for every product at the same time.',
        'Hand each product to its subagent and run products that do not depend on each other in parallel (several Task calls in one message), never one after another. Browser work (Claude in Chrome and the like) also runs at the same time, each subagent in its own tab.',
        'Remove each finished item from human.md together with its line under "## Answers". If an answer raises something new for a person, add it to human.md as a question block (with options and a recommendation).'
      ]
  const rules = allowed?.trim() ? [ja ? '人の確認なしで進めてよい操作（human.md に載せずに進める）:' : 'Operations a person allows without asking (do them without adding them to human.md):', allowed.trim()].join('\n') : ''
  const fixed = [head.join('\n'), rules].filter(Boolean).join('\n\n')
  const limit = 7800 - fixed.length
  const lines: string[] = []
  let used = 0
  let skipped = 0
  // プロダクトごとにまとめる（どのプロダクトのどの質問への答えか分かるように）
  const products = [...new Set(answered.map((it) => it.label))]
  for (const product of products) {
    const head = `### ${product || (ja ? 'プロダクトの指定なし' : 'No product')}`
    let wroteHead = false
    for (const it of answered.filter((x) => x.label === product)) {
      const question = [it.note, it.url].filter(Boolean).join(' ')
      const line = `- ${it.key}: ${question}\n  → ${ja ? '答え' : 'Answer'}: ${it.answer}`
      const size = line.length + 1 + (wroteHead ? 0 : head.length + 2)
      if (used + size > limit) { skipped += 1; continue }
      if (!wroteHead) { lines.push(`${lines.length ? '\n' : ''}${head}`); wroteHead = true }
      lines.push(line)
      used += size
    }
  }
  const more = skipped ? (ja ? `（ほか ${skipped} 件は human.md の「## 回答」を読んでください）` : `(${skipped} more: read "## Answers" in human.md)`) : ''
  return [head.join('\n'), [ja ? '答え:' : 'Answers:', ...lines, more].filter(Boolean).join('\n'), rules].filter(Boolean).join('\n\n')
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

/** プロダクトごとにまとめる（最初に出た順。プロダクトの無い項目は空の名前） */
export function checklistGroups<T extends { label: string }>(items: readonly T[]): Array<{ product: string; items: T[] }> {
  const groups = new Map<string, T[]>()
  for (const it of items) groups.set(it.label, [...(groups.get(it.label) ?? []), it])
  return [...groups].map(([product, list]) => ({ product, items: list }))
}
