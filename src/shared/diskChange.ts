/**
 * エディタで開いているファイルが「ディスク側で変わった」と知らされたときに、どう扱うかを決める（純粋関数）。
 *
 * 自分の保存の直後にも知らせは来る（監視の通知、main の読み直しと書き戻し）。中身で見分けないと、
 * 自分の保存なのに「編集中にディスク側が変わりました」と警告してしまう。
 * main は settings.json を読み直すと、整形し直して書き戻すことがあるので、JSON は空白や改行の違いを同じとみなす。
 *
 *   ignore   … ディスクとエディタの中身が同じ（改行コード・末尾の改行の違いは同じとみなす）。基準だけ揃え、未保存の印も消す
 *   adopt    … 意味は同じで、書き方だけ違う（自分の保存を main が整形した）。黙ってディスクの文に差し替える
 *   reload   … 編集していない。ディスクの内容を取り込む
 *   keep     … ディスク側は整形し直しただけで、編集中の内容は別にある。基準を揃え、編集は残す（警告しない）
 *   conflict … 編集中に、外から中身が変わった。上書きせずに知らせる
 */
export type DiskChangeAction = 'ignore' | 'adopt' | 'reload' | 'keep' | 'conflict'

export function classifyDiskChange({
  disk,
  baseline,
  current,
  json = false
}: {
  /** いまのディスクの内容 */
  disk: string
  /** エディタが最後に読んだ（または保存した）内容 */
  baseline: string
  /** エディタの今の内容 */
  current: string
  /** JSON として比べてよいか（空白・改行・キーの並びの書き方の違いを無視する） */
  json?: boolean
}): DiskChangeAction {
  if (sameText(disk, current)) return 'ignore'
  if (json && sameJson(disk, current)) return 'adopt'
  if (current === baseline) return 'reload'
  if (disk === baseline || (json && sameJson(disk, baseline))) return 'keep'
  return 'conflict'
}

/**
 * 文として同じか。改行コード（CRLF / LF）と末尾の改行の有無の違いは同じとみなす
 * （エディタやファイルシステムで変わりうるため）。途中の改行の数が違えば別の内容。
 */
export function sameText(a: string, b: string): boolean {
  return normalizeNewlines(a) === normalizeNewlines(b)
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
}

/** JSON として同じ値か。どちらかが読めなければ false */
export function sameJson(a: string, b: string): boolean {
  try {
    return canonical(JSON.parse(a)) === canonical(JSON.parse(b))
  } catch {
    return false
  }
}

/** キーの順を揃えた文字列（オブジェクトのキーの並びの違いは同じとみなす。配列の順は意味があるので保つ） */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}
