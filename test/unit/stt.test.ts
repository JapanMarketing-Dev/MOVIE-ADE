/** whisper.cpp を実際に呼ばないテスト（引数の組み立てと出力のパース） */
import { describe, expect, it } from 'vitest'
import { buildWhisperArgs, cleanText, normalizeLanguage, toSegments } from '../../src/main/pipeline/stt/whisper'
import type { WhisperOptions } from '../../src/main/pipeline/stt/whisper'
import { defaultWhisperModel, whisperModels } from '../../src/main/pipeline/stt/models'

const opt: WhisperOptions = {
  binary: '/opt/homebrew/bin/whisper-cli',
  model: '/models/ggml-large-v3-turbo.bin',
  language: 'ja',
}

describe('whisper-cli の引数', () => {
  it('モデル・入力・言語・JSON出力を渡す', () => {
    const args = buildWhisperArgs(opt, '/tmp/a.wav', '/tmp/out')
    expect(args).toEqual([
      '-m', '/models/ggml-large-v3-turbo.bin',
      '-f', '/tmp/a.wav',
      '-l', 'ja',
      '-oj',
      '-of', '/tmp/out',
      '-np',
    ])
  })

  it('スレッド数・貪欲デコード・非音声抑制・GPU無効・初期プロンプトを足せる', () => {
    const args = buildWhisperArgs(
      { ...opt, threads: 8, greedy: true, suppressNonSpeech: true, noGpu: true, initialPrompt: 'UI用語' },
      '/tmp/a.wav',
      '/tmp/out',
    )
    expect(args).toContain('-t')
    expect(args).toContain('8')
    expect(args.join(' ')).toContain('-bo 1 -bs 1')
    expect(args).toContain('-sns')
    expect(args).toContain('-ng')
    expect(args.join(' ')).toContain('--prompt UI用語')
  })
})

describe('whisper の JSON 出力のパース', () => {
  const input = { wavPath: '/tmp/a.wav', offsetMs: 30_000, speaker: 'other' as const, source: 'system' as const }

  it('offsets に録画開始からのオフセットを足し、話者と系統を付ける', () => {
    const segs = toSegments(
      { transcription: [{ offsets: { from: 1_200, to: 3_400 }, text: ' このボタンの色が薄いです ' }] },
      input,
    )
    expect(segs).toEqual([
      { t0: 31_200, t1: 33_400, speaker: 'other', text: 'このボタンの色が薄いです', source: 'system' },
    ])
  })

  it('offsets が無ければ timestamps 文字列から時刻を取る', () => {
    const segs = toSegments(
      { transcription: [{ timestamps: { from: '00:00:02,500', to: '00:00:04,000' }, text: 'はい' }] },
      input,
    )
    expect(segs[0]!.t0).toBe(32_500)
    expect(segs[0]!.t1).toBe(34_000)
  })

  it('空の区間とプレースホルダを捨てる', () => {
    const segs = toSegments(
      {
        transcription: [
          { offsets: { from: 0, to: 100 }, text: '  ' },
          { offsets: { from: 100, to: 200 }, text: '[BLANK_AUDIO]' },
          { offsets: { from: 200, to: 300 }, text: '（音楽）' },
          { offsets: { from: 300, to: 400 }, text: 'ここ' },
        ],
      },
      input,
    )
    expect(segs.map((s) => s.text)).toEqual(['ここ'])
  })

  it('transcription が無くても落ちない', () => {
    expect(toSegments({}, input)).toEqual([])
  })
})

describe('テキストの掃除', () => {
  it('無音・BGMのプレースホルダを落とす', () => {
    expect(cleanText('[BLANK_AUDIO]')).toBe('')
    expect(cleanText('（拍手）')).toBe('')
    expect(cleanText('[_TT_30]')).toBe('')
    expect(cleanText(' 本文です ')).toBe('本文です')
  })
})

describe('モデル一覧', () => {
  it('既定モデルが一覧に存在し、ダウンロードURLを持つ', () => {
    const m = whisperModels[defaultWhisperModel]
    expect(m).toBeDefined()
    expect(m.url).toMatch(/^https:\/\/huggingface\.co\//)
    expect(m.file).toBe(`ggml-${defaultWhisperModel}.bin`)
  })
})

describe('言語指定は必ず明示する（04_benchmark.md 3.7 の最重要の罠）', () => {
  it('-l を必ず含める（省略すると英語扱いになる）', () => {
    for (const language of ['ja', 'en', 'auto'] as const) {
      const args = buildWhisperArgs({ ...opt, language }, '/tmp/a.wav', '/tmp/out')
      expect(args).toContain('-l')
      expect(args[args.indexOf('-l') + 1]).toBe(language)
    }
  })

  it('設定が空・未知でも省略せず auto を渡す', () => {
    expect(normalizeLanguage(undefined)).toBe('auto')
    expect(normalizeLanguage('')).toBe('auto')
    expect(normalizeLanguage('  ')).toBe('auto')
    expect(normalizeLanguage('AUTO')).toBe('auto')
    expect(normalizeLanguage('JA')).toBe('ja')

    const args = buildWhisperArgs({ ...opt, language: normalizeLanguage('') }, '/tmp/a.wav', '/tmp/o')
    expect(args[args.indexOf('-l') + 1]).toBe('auto')
  })
})
