import { describe, expect, it } from 'vitest'
import { isMeaninglessUtterance, meaninglessKind } from '../../src/main/pipeline/meaningless'

describe('意味の通じない発話の判定', () => {
  it.each([
    '', '   ', '。', '…', '...', '♪', '♪〜♪', '🎵🎵', '😀', '!?', '、、、',
  ])('空・記号・絵文字・音符だけ（%j）は意味なし', (text) => {
    expect(isMeaninglessUtterance(text)).toBe(true)
    expect(meaninglessKind(text)).toBe('empty')
  })

  it.each(['ん', 'あ', 'w', 'www', 'あああ', 'a'])('かな・ラテン文字の1字や同じ字の繰り返し（%j）は意味なし', (text) => {
    expect(isMeaninglessUtterance(text)).toBe(true)
  })

  it.each([
    'Shh.', 'shhh', 'Thank you.', 'Thanks for watching!', 'Thank you for watching.', 'you', 'You.', 'Bye.',
    'ご視聴ありがとうございました', 'ご視聴ありがとうございました。', 'チャンネル登録よろしくお願いします！',
    'Subtitles by the Amara.org community', 'Untertitel im Auftrag des ZDF, 2021', '谢谢观看', '시청해주셔서 감사합니다.',
    "Merci d'avoir regardé !", 'Gracias por ver.', 'Спасибо за просмотр!',
  ])('文字起こしの決まり文句（%j）は意味なし', (text) => {
    expect(isMeaninglessUtterance(text)).toBe(true)
    expect(isMeaninglessUtterance(text, { hasAnnotation: true })).toBe(true)
  })

  it.each(['[Music]', '(笑)', '（笑）', '【拍手】', '(laughs)', '[BLANK_AUDIO]', '*applause*'])('音の注記だけ（%j）は意味なし', (text) => {
    expect(isMeaninglessUtterance(text, { hasAnnotation: true })).toBe(true)
  })

  it.each([
    'えー', 'えーっと', 'えっと', 'ええと', 'あの', 'あのー', 'その', 'うーん', 'うん', 'うんうん', 'あぁ', 'んー', 'まあ',
    'えー、あの', 'えーとあの', 'あのー、その、えっと', 'Um.', 'uh', 'Hmm...', 'mhm', 'Uh, um.', 'Oh.', 'Shh, um',
  ])('つなぎ言葉・間投詞だけ（%j）は意味なし', (text) => {
    // 「えー」「んー」は長音を落とすと1字なので single になる。どちらでも書き込みの有無によらず意味なし
    expect(['filler', 'single']).toContain(meaninglessKind(text))
    expect(isMeaninglessUtterance(text, { hasAnnotation: true })).toBe(true)
  })

  it.each(['はい', 'はい。', 'はいはい', 'ええ', 'OK', 'Okay.', 'ok ok', 'Yes.', 'Yeah', 'All right.', 'えー、はい'])(
    '返事だけ（%j）は書き込みが無いときだけ意味なし', (text) => {
      expect(meaninglessKind(text)).toBe('acknowledgement')
      expect(isMeaninglessUtterance(text)).toBe(true)
      expect(isMeaninglessUtterance(text, { hasAnnotation: false })).toBe(true)
      expect(isMeaninglessUtterance(text, { hasAnnotation: true })).toBe(false)
    })

  it.each([
    '消して', '赤に', 'ここ', '大きく', 'No.', 'Bigger', '赤', '5', 'もっと右', '上', 'うえ', 'ううん', 'いいえ', 'だめ',
    'この見出しが小さいですね', 'Thank you, but make the button bigger', 'ありがとうございます、でもここは青に',
    'あの、ここ消して', 'Um, move it left', 'Okay, delete this', 'はい、これを消して', 'その画像を消して', 'そのまま',
    '字幕を大きくして作成', 'Shh, the logo is too big', 'Music section is broken', 'you can delete this', 'Delete',
  ])('短くても指示になる言葉・決まり文句を含むだけの文（%j）は残す', (text) => {
    expect(isMeaninglessUtterance(text)).toBe(false)
    expect(meaninglessKind(text)).toBeNull()
  })
})
