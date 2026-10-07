import { describe, expect, it } from 'vitest'
import { selectionTextForCopy, unwrapCopiedLines, cellWidth, estimateTextWidth, type SelectionTerminalLike } from '../../src/renderer/terminal/wrappedCopy'

/** 画面行（右の空白は落ちる）と isWrapped から、xterm の選択の偽物を作る。選択は start〜end（0 始まり、end.x は含まない） */
function fakeTerm(cols: number, rows: Array<string | { text: string; wrapped: true }>, start: { x: number; y: number }, end: { x: number; y: number }): SelectionTerminalLike {
  const lines = rows.map((r) => (typeof r === 'string' ? { text: r, wrapped: false } : { text: r.text, wrapped: true }))
  const slice = (text: string, s = 0, e?: number) => {
    // テストの行は半角だけ（全角はセル単位とずれるので使わない）
    const out = text.slice(s, e)
    return out.replace(/\s+$/, '')
  }
  const term: SelectionTerminalLike = {
    cols,
    buffer: { active: { getLine: (y) => (lines[y] ? { isWrapped: lines[y]!.wrapped, translateToString: (trim, s, e) => (trim ? slice(lines[y]!.text, s, e) : lines[y]!.text.slice(s, e)) } : undefined) } },
    getSelectionPosition: () => ({ start, end }),
    getSelection: () => {
      const out: string[] = []
      for (let y = start.y; y <= end.y; y++) {
        const part = slice(lines[y]!.text, y === start.y ? start.x : 0, y === end.y ? end.x : undefined)
        if (lines[y]!.wrapped && out.length > 0) out[out.length - 1] += part
        else out.push(part)
      }
      return out.join('\n')
    }
  }
  return term
}

/** wrap-ansi（Ink）と同じく語の切れ目で幅 width に折り返し、各行に indent を付ける */
function inkWrap(text: string, width: number, indent = '  '): string[] {
  const words = text.split(' ')
  const rows: string[] = []
  let row = ''
  for (const word of words) {
    if (row && row.length + 1 + word.length > width - indent.length) {
      rows.push(indent + row)
      row = word
    } else row = row ? `${row} ${word}` : word
  }
  if (row) rows.push(indent + row)
  return rows
}

describe('ターミナルのコピーで TUI の折り返しを戻す', () => {
  const command = 'gcloud auth application-default login --project=my-very-long-project-name --scopes=https://www.googleapis.com/auth/cloud-platform'

  it('Ink が語の切れ目で折り返したコマンドは、空白1つで1行に戻る', () => {
    const cols = 60
    const rows = inkWrap(command, cols)
    expect(rows.length).toBeGreaterThan(1)
    const term = fakeTerm(cols, rows, { x: 2, y: 0 }, { x: rows[rows.length - 1]!.length, y: rows.length - 1 })
    expect(selectionTextForCopy(term)).toBe(command)
  })

  it('幅より長い語（URL）を途中で切った行は、空白を入れずにつなぐ', () => {
    const cols = 40
    const url = 'https://example.com/' + 'a'.repeat(50) + '/callback'
    const rows = ['  ' + url.slice(0, 38), '  ' + url.slice(38, 76), '  ' + url.slice(76)]
    const term = fakeTerm(cols, rows, { x: 2, y: 0 }, { x: rows[2]!.length, y: 2 })
    expect(selectionTextForCopy(term)).toBe(url)
  })

  it('短い行で終わる本当の改行は残す', () => {
    const term = fakeTerm(80, ['cd my-app', 'npm install'], { x: 0, y: 0 }, { x: 11, y: 1 })
    expect(selectionTextForCopy(term)).toBe('cd my-app\nnpm install')
  })

  it('次の語が入る余地のある行は、改行を残す（幅は前後の行から見積もる）', () => {
    const cols = 40
    const first = 'x'.repeat(33)
    // 前の段落の行が 38 桁まで埋まっている＝ TUI の幅は 38 以上。ab は 33 桁の行に入るので本当の改行
    const term = fakeTerm(cols, ['y'.repeat(20) + ' ' + 'z'.repeat(17), first, 'ab cd'], { x: 0, y: 1 }, { x: 5, y: 2 })
    expect(selectionTextForCopy(term)).toBe(`${first}\nab cd`)
  })

  it('右端まで届く枠線の行は幅の見積もりに入れない', () => {
    const cols = 40
    // Ink の幅は 36。前の説明の段落が 36 桁近くまで届き、上に端末の幅いっぱいの区切り線がある
    const prose = inkWrap('Run the following command in your terminal to sign in and then come back here to continue the setup', 36)
    const cmd = inkWrap('npx some-tool login --flag-one value --flag-two another-long-value', 36)
    const rows = ['─'.repeat(40), ...prose, '', ...cmd, '╰' + '─'.repeat(38) + '╯']
    const top = 1 + prose.length + 1
    expect(cmd.length).toBeGreaterThan(1)
    const term = fakeTerm(cols, rows, { x: 2, y: top }, { x: cmd[cmd.length - 1]!.length, y: top + cmd.length - 1 })
    expect(selectionTextForCopy(term)).toBe('npx some-tool login --flag-one value --flag-two another-long-value')
  })

  it('ふつうの複数行のコマンド（短い行）はつながない', () => {
    const rows = ['  git add -A', '  git commit -m "fix: a long commit message that is long"', '  git push']
    const term = fakeTerm(80, rows, { x: 2, y: 0 }, { x: rows[2]!.length, y: 2 })
    expect(selectionTextForCopy(term)).toBe('git add -A\n  git commit -m "fix: a long commit message that is long"\n  git push')
  })

  it('行末の \\ の続き行はそのまま', () => {
    const cols = 30
    const rows = ['docker run --rm -it --name x \\', '  image:latest']
    const term = fakeTerm(cols, rows, { x: 0, y: 0 }, { x: rows[1]!.length, y: 1 })
    expect(selectionTextForCopy(term)).toBe(rows.join('\n'))
  })

  it('xterm 自身の折り返し（isWrapped）は今までどおり1行', () => {
    const cols = 20
    const rows: Array<string | { text: string; wrapped: true }> = ['echo aaaaaaaaaaaaaaa', { text: 'bbbbbbbbbb', wrapped: true }]
    const term = fakeTerm(cols, rows, { x: 0, y: 0 }, { x: 10, y: 1 })
    expect(selectionTextForCopy(term)).toBe('echo aaaaaaaaaaaaaaabbbbbbbbbb')
  })

  it('空行をはさんだ段落は分けたまま', () => {
    const cols = 40
    const a = 'a'.repeat(39)
    const term = fakeTerm(cols, [a, '', 'b'], { x: 0, y: 0 }, { x: 1, y: 2 })
    expect(selectionTextForCopy(term)).toBe(`${a}\n\nb`)
  })

  it('Windows では改行を CRLF で返す', () => {
    const term = fakeTerm(80, ['one', 'two'], { x: 0, y: 0 }, { x: 3, y: 1 })
    expect(selectionTextForCopy(term, '\r\n')).toBe('one\r\ntwo')
  })

  it('日本語の文の折り返しは空白を入れずにつなぐ', () => {
    const cols = 24
    const first = '  これは長い日本語の文で' // 2 + 11*2 = 24 セル
    expect(cellWidth(first)).toBe(24)
    const lines = [
      { text: first.trimStart(), firstRow: first, lastRow: first, used: 24 },
      { text: '  す。', firstRow: '  す。', lastRow: '  す。', used: 6 }
    ]
    expect(unwrapCopiedLines(lines, cols, 24)).toBe('これは長い日本語の文です。')
  })

  it('幅の見積もりは、2行以上が揃って右まで届いているときだけ', () => {
    expect(estimateTextWidth([78, 77, 40, 12], 80)).toBe(78)
    expect(estimateTextWidth([78, 40, 12], 80)).toBe(80)
    expect(estimateTextWidth([30, 30], 80)).toBe(80)
  })

  it('狭すぎる端末では手を出さない', () => {
    const term = fakeTerm(12, ['abcdefghijk', 'lmn'], { x: 0, y: 0 }, { x: 3, y: 1 })
    expect(selectionTextForCopy(term)).toBe('abcdefghijk\nlmn')
  })
})
