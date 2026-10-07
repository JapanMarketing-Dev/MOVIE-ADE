/**
 * ターミナルの選択を写すときに、TUI が自分で折り返した行（ハードラップ）を1行に戻す。
 *
 * Claude Code（Ink）や Codex は、端末の幅に合わせて自分で改行を出す。xterm の折り返し（isWrapped）ではないので、
 * 狭いウインドウで「これを貼って実行して」と出たコマンドを選んで写すと、折り返しの位置に改行と字下げが入り、
 * 貼った途端に途中までで実行されてしまう。
 *
 * 戻すのは「次の行の最初の語が、この行の残りに入りきらなかった」ときだけ（Ink の折り返し＝wrap-ansi が改行を入れる条件そのもの）。
 * 行の幅は、選択とその前後の画面行の埋まり方で見積もる（枠線の行は除く。estimateTextWidth）。
 * 次の語が入る余地のある改行（ふつうの複数行のコマンド）・行末の \ は残す。
 *   - 語の切れ目で折り返していれば空白1つでつなぐ（wrap-ansi は切れ目の空白を前の行の末尾に置き、端末では見えない）
 *   - 幅より長い語（URL・日本語の文など）を途中で切っていれば、空白を入れずにつなぐ
 *   - 続きの行の字下げ（Ink の Box の余白）は落とす
 */

/** これより狭い端末では何もしない（判断が当てにならない） */
const MIN_COLS = 20
/** TUI の行の幅を見積もるのに、選択の前後で見る画面行の数 */
const WIDTH_CONTEXT_ROWS = 60

export interface CopiedLine {
  /** 選択された部分（xterm の選択と同じ。ソフト折り返しはつないで、右の空白を落とした文字列） */
  text: string
  /** この論理行の最初の画面行の全体（右の空白を落とす）。次の語の幅を測るのに使う */
  firstRow: string
  /** この論理行の最後の画面行の全体（右の空白を落とす） */
  lastRow: string
  /** 最後の画面行で文字が入っている右端（セル数。空行は 0） */
  used: number
}

/** 東アジアの全角・絵文字は2セル（ざっくり。折り返しの判断に使うだけ） */
function charCells(cp: number): number {
  if (cp < 0x1100) return 1
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2
  return 1
}

export function cellWidth(text: string): number {
  let w = 0
  for (const ch of text) w += charCells(ch.codePointAt(0)!)
  return w
}

const isWide = (ch: string | undefined): boolean => ch !== undefined && charCells(ch.codePointAt(0)!) === 2

function firstToken(row: string): string {
  return row.trimStart().split(/\s/, 1)[0] ?? ''
}

function lastToken(row: string): string {
  const parts = row.trimEnd().split(/\s/)
  return parts[parts.length - 1] ?? ''
}

function leadingSpaces(row: string): number {
  return row.length - row.trimStart().length
}

/** line の次に next が続くなら、つなぐ文字（'' か ' '）。続きでなければ null */
export function wrapJoiner(line: CopiedLine, next: CopiedLine, cols: number, width: number): string | null {
  if (cols < MIN_COLS) return null
  const tail = line.lastRow.trimEnd()
  const head = next.firstRow.trimStart()
  if (!tail || !head) return null
  // 行末の \ は利用者が意図した続き行（そのまま改行を残せば貼っても1つのコマンドとして動く）
  if (tail.endsWith('\\')) return null
  const nextWord = firstToken(head)
  // 次の語がこの行に入ったなら、TUI はここで折り返さない＝本当の改行
  if (line.used + 1 + cellWidth(nextWord) <= width) return null
  // 幅より長い語を途中で切った（wrap-ansi の hard）: 行が幅いっぱいまで埋まり、切れた語の前後を足すと幅を超える。
  // 日本語の文も語の区切りが無いので空白を入れない
  const content = width - leadingSpaces(line.lastRow)
  const lastWord = lastToken(tail)
  if (line.used >= width && cellWidth(lastWord) + cellWidth(nextWord) > content) return ''
  if (isWide([...tail].pop()) || isWide([...head][0])) return ''
  return ' '
}

/**
 * TUI の行の幅（右の余白を除く）の見積もり。used は選択とその前後の文の行の埋まった桁数。
 * いちばん右まで埋まった位置に2行以上が揃い、端末の幅の 7 割以上なら、そこを TUI の幅とみなす
 * （折り返した段落は何行も同じ幅まで届く）。そう言えなければ端末の幅（つなぐのは確かなときだけになる）
 */
export function estimateTextWidth(used: readonly number[], cols: number): number {
  const max = Math.min(cols, Math.max(0, ...used))
  const near = used.filter((u) => u >= max - 2).length
  return max >= cols * 0.7 && near >= 2 ? max : cols
}

/** 選択した行を、ハードラップを戻してつなぐ。width は TUI の行の幅（estimateTextWidth） */
export function unwrapCopiedLines(lines: readonly CopiedLine[], cols: number, width: number, newline = '\n'): string {
  if (lines.length === 0) return ''
  let out = lines[0]!.text
  for (let i = 0; i + 1 < lines.length; i++) {
    const joiner = wrapJoiner(lines[i]!, lines[i + 1]!, cols, width)
    const nextText = lines[i + 1]!.text
    out = joiner === null ? out + newline + nextText : out.trimEnd() + joiner + nextText.trimStart()
  }
  return out
}

/** xterm の公開 API のうち、ここで使う分 */
interface BufferLineLike {
  readonly isWrapped: boolean
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}
export interface SelectionTerminalLike {
  readonly cols: number
  getSelection(): string
  getSelectionPosition(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined
  readonly buffer: { readonly active: { getLine(y: number): BufferLineLike | undefined } }
}

const NBSP = /\u00a0/g
/** 罫線・枠（Claude Code の入力欄の枠や区切り線）。文の幅の見積もりに入れない */
const BOX_DRAWING = /[\u2500-\u259f]/

/** 文の行として幅の見積もりに使える行か（枠線や枠の中の行は端まで届くので除く） */
function isTextRow(row: string): boolean {
  const trimmed = row.trim()
  if (!trimmed) return false
  return !BOX_DRAWING.test(trimmed[0]!) && !BOX_DRAWING.test(trimmed[trimmed.length - 1]!)
}

/**
 * 端末の今の選択を、ハードラップを戻した文字列にする。選択の位置が読めなければ xterm の選択をそのまま返す。
 * 位置は 0 始まり（x は終わりを含まない。xterm 5 の selectionStart / selectionEnd）
 */
export function selectionTextForCopy(term: SelectionTerminalLike, newline = '\n'): string {
  const raw = term.getSelection()
  const pos = term.getSelectionPosition()
  if (!raw || !pos) return raw
  const buffer = term.buffer.active
  const lines: CopiedLine[] = []
  for (let y = pos.start.y; y <= pos.end.y; y++) {
    const row = buffer.getLine(y)
    if (!row) return raw
    const startCol = y === pos.start.y ? pos.start.x : 0
    const endCol = y === pos.end.y ? pos.end.x : undefined
    const part = row.translateToString(true, startCol, endCol).replace(NBSP, ' ')
    const whole = row.translateToString(true).replace(NBSP, ' ')
    const used = cellWidth(whole)
    const last = lines[lines.length - 1]
    if (row.isWrapped && last) {
      last.text += part
      last.lastRow = whole
      last.used = used
    } else {
      lines.push({ text: part, firstRow: whole, lastRow: whole, used })
    }
  }
  // 矩形選択など、xterm の選択と行の数が合わないときは手を出さない
  if (lines.length !== raw.split(/\r?\n/).length) return raw
  // TUI の行の幅: 選択とその前後で、次の行へ xterm が折り返していない文の行の埋まり方から見積もる
  const used: number[] = []
  for (let y = Math.max(0, pos.start.y - WIDTH_CONTEXT_ROWS); y <= pos.end.y + WIDTH_CONTEXT_ROWS; y++) {
    const row = buffer.getLine(y)
    if (!row) {
      if (y > pos.end.y) break
      continue
    }
    if (buffer.getLine(y + 1)?.isWrapped) continue
    const whole = row.translateToString(true)
    if (isTextRow(whole)) used.push(cellWidth(whole.replace(NBSP, ' ')))
  }
  return unwrapCopiedLines(lines, term.cols, estimateTextWidth(used, term.cols), newline)
}
