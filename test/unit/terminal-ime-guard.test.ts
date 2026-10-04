import { describe, expect, it } from 'vitest'
import { IME_DUPLICATE_WINDOW_MS, ImeInputGuard } from '../../src/renderer/terminal/imeInputGuard'

/** xterm の onData に届く順をそのまま流し、PTY へ送られる文字列をつなげて返す */
function run(steps: Array<['start'] | ['end', number, string?] | ['key', number, boolean?] | ['data', string, number]>): string {
  const guard = new ImeInputGuard()
  let out = ''
  for (const step of steps) {
    if (step[0] === 'start') guard.compositionStart()
    else if (step[0] === 'end') guard.compositionEnd(step[1], step[2])
    else if (step[0] === 'key') guard.keyDown({ keyCode: step[1], isComposing: step[2] ?? false })
    else out += guard.filter(step[1], step[2])
  }
  return out
}

describe('ImeInputGuard（IME の確定文字を2回送らない）', () => {
  it('macOS: 確定が keyup のあとの insertText で届き、_inputEvent と CompositionHelper の両方が送っても1回', () => {
    // keydown(229) → compositionstart → … → compositionend → input(insertText) → setTimeout(0) の送信
    expect(run([['key', 229, true], ['start'], ['end', 10], ['data', '日本語', 11], ['data', '日本語', 12]])).toBe('日本語')
  })

  it('Windows: insertText が compositionend より先に届いても1回', () => {
    expect(run([['key', 229, true], ['start'], ['data', 'テスト', 5], ['end', 6], ['data', 'テスト', 7]])).toBe('テスト')
  })

  it('Enter で確定: keydown(13) の即時送信と compositionend の遅れた送信が重なっても1回、改行は送る', () => {
    expect(run([['start'], ['key', 13, false], ['data', 'かな', 5], ['data', '\r', 5], ['end', 6], ['data', 'かな', 7]])).toBe('かな\r')
  })

  it('確定文字のあとに続けて打った文字がまとめて来たら、続きだけ送る', () => {
    expect(run([['start'], ['end', 10], ['data', 'あ', 11], ['data', 'あ2', 12]])).toBe('あ2')
  })

  it('別の変換で同じ文字を確定したら、どちらも送る', () => {
    expect(run([['start'], ['end', 10], ['data', 'はい', 11], ['start'], ['end', 40], ['data', 'はい', 41]])).toBe('はいはい')
  })

  it('変換が終わって時間が経ってから同じ文字が来たら送る（変換の外の入力）', () => {
    expect(run([['start'], ['end', 10], ['data', 'a', 11], ['data', 'a', 11 + IME_DUPLICATE_WINDOW_MS + 1]])).toBe('aa')
  })

  it('変換のあと普通のキーを打ったら、区切りを閉じて同じ文字も送る', () => {
    expect(run([['start'], ['end', 10], ['data', 'x', 11], ['key', 88], ['data', 'x', 12]])).toBe('xx')
  })

  it('韓国語: 前の音節の確定が次の変換の最中に届き、同じ音節が続いて句読点で確定しても落とさない（Orca #24663）', () => {
    // ㅋ → ㅋ → . : 1つ目の ㅋ は2つ目の変換が始まってから届き、2つ目は「ㅋ.」としてまとめて確定する
    expect(run([['start'], ['end', 10], ['start'], ['data', 'ㅋ', 11], ['end', 20], ['data', 'ㅋ.', 21]])).toBe('ㅋㅋ.')
    expect(run([['start'], ['end', 10], ['start'], ['data', '하', 11], ['end', 20], ['data', '하.', 21], ['data', '하.', 22]])).toBe('하하.')
    expect(run([['start'], ['end', 10], ['start'], ['data', 'ㅋ', 11], ['end', 20], ['start'], ['data', 'ㅋ', 21], ['end', 30], ['data', 'ㅋ.', 31]])).toBe('ㅋㅋㅋ.')
  })

  it('前の変換の確定が、次の変換の最中にもう一度届いたら1回', () => {
    expect(run([['start'], ['end', 10], ['data', '한', 11], ['start'], ['data', '한', 12], ['end', 20], ['data', '글', 21]])).toBe('한글')
  })

  it('macOS のライブ変換の部分確定: 変換中の残りが付いて届いても、確定した頭だけを送り、文が重ならない', () => {
    // 「人材紹介ないことを」を変換中に頭の「人材紹介」だけ確定し、残りの変換を続ける。xterm は前の変換の長さ（9文字）で
    // 入力欄を切り出すので、確定の頭に変換中の残りの頭が付いて届く（「ないことを」が2回、途中の候補も入っていた）
    expect(run([
      ['key', 229, true], ['start'], ['end', 10, '人材紹介'], ['start'], ['data', '人材紹介ないことを', 11],
      ['end', 20, 'ないことを'], ['start'], ['data', 'ないことを再度確認し', 21],
      ['end', 30, '再度確認してから'], ['data', '再度確認してから', 31]
    ])).toBe('人材紹介ないことを再度確認してから')
    // 途中の候補（「再度書く」）が付いて届いても送らない
    expect(run([['start'], ['end', 10, 'ok'], ['start'], ['data', 'ok再度書く', 11], ['end', 20, '再度確認'], ['data', '再度確認', 21]])).toBe('ok再度確認')
  })

  it('部分確定: 確定文字が遅れて2回届いても1回、確定のあと続けて変換しても後の確定は送る', () => {
    expect(run([['start'], ['end', 10, '日本'], ['start'], ['data', '日本語', 11], ['data', '日本', 12], ['end', 20, '語'], ['data', '語', 21]])).toBe('日本語')
  })

  it('compositionend の確定文字が分からない・取り消しのときは、届いたものをそのまま送る', () => {
    expect(run([['start'], ['end', 10], ['start'], ['data', 'かな', 11], ['end', 20], ['data', 'カナ', 21]])).toBe('かなカナ')
    expect(run([['start'], ['end', 10, ''], ['start'], ['data', 'かな漢', 11], ['end', 20, '漢字'], ['data', '漢字', 21]])).toBe('かな漢漢字')
  })

  it('変換と関係のない打鍵・貼り付けには触らない', () => {
    expect(run([['data', 'l', 1], ['data', 'l', 2], ['data', '\x1b[200~ls\x1b[201~', 3], ['data', '\x1b[200~ls\x1b[201~', 4]])).toBe('ll\x1b[200~ls\x1b[201~\x1b[200~ls\x1b[201~')
  })
})
