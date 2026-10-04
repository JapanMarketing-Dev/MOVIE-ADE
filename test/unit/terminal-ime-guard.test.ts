import { describe, expect, it } from 'vitest'
import { IME_DUPLICATE_WINDOW_MS, ImeInputGuard } from '../../src/renderer/terminal/imeInputGuard'

/** xterm の onData に届く順をそのまま流し、PTY へ送られる文字列をつなげて返す */
function run(steps: Array<['start'] | ['end', number] | ['key', number, boolean?] | ['data', string, number]>): string {
  const guard = new ImeInputGuard()
  let out = ''
  for (const step of steps) {
    if (step[0] === 'start') guard.compositionStart()
    else if (step[0] === 'end') guard.compositionEnd(step[1])
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

  it('変換と関係のない打鍵・貼り付けには触らない', () => {
    expect(run([['data', 'l', 1], ['data', 'l', 2], ['data', '\x1b[200~ls\x1b[201~', 3], ['data', '\x1b[200~ls\x1b[201~', 4]])).toBe('ll\x1b[200~ls\x1b[201~\x1b[200~ls\x1b[201~')
  })
})
