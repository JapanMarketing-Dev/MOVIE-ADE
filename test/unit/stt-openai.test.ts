/** OpenAI STT エンジンのテスト（APIを呼ばない。リクエストの組み立てと応答のパースだけ） */
import { describe, expect, it } from 'vitest'
import { OpenAiSttEngine, openAiSttPricePerMinuteUsd, type OpenAiSttModel } from '../../src/main/pipeline/stt/openai'
import type { TranscribeChunkInput } from '../../src/main/pipeline/stt/engine'

// 期待値は日本語の文言。画面の言語を日本語に固定する（既定は英語）
import { setLocale } from '@shared/i18n'
setLocale('ja')

const input: TranscribeChunkInput = {
  wavPath: '/tmp/c001.wav',
  offsetMs: 30_000,
  speaker: 'other',
  source: 'system',
  durationMs: 12_000,
}

const engine = (model: OpenAiSttModel, extra = {}) =>
  new OpenAiSttEngine({ model, apiKey: 'test-key', language: 'ja', ...extra })

/** FormData の値を取り出す（`entries()` は DOM.Iterable が必要なので使わない） */
function values(f: FormData, key: string): string[] {
  return f.getAll(key).map((v) => String(v))
}

describe('リクエストの組み立て（モデルごとの違い）', () => {
  it('gpt-transcribe: 時刻を返さないので json、言語は languages[]、prompt と keywords が使える', () => {
    const e = engine('gpt-transcribe', { prompt: 'UI用語', keywords: ['トグル', '税抜'] })
    const form = e.buildForm(Buffer.from('x'), 'c.wav')
    expect(values(form, 'model')).toEqual(['gpt-transcribe'])
    expect(values(form, 'response_format')).toEqual(['json'])
    expect(values(form, 'languages[]')).toEqual(['ja'])
    expect(values(form, 'prompt')).toEqual(['UI用語'])
    expect(values(form, 'keywords[]')).toEqual(['トグル', '税抜'])
    expect(values(form, 'timestamp_granularities[]')).toEqual([])
    expect(e.hasTimestamps).toBe(false)
    expect(e.hasDiarization).toBe(false)
  })

  it('gpt-4o-transcribe-diarize: diarized_json と chunking_strategy を付け、prompt は送らない', () => {
    const e = engine('gpt-4o-transcribe-diarize', { prompt: '無視される', knownSpeakerNames: ['自分', '相手'] })
    const form = e.buildForm(Buffer.from('x'), 'c.wav')
    expect(values(form, 'response_format')).toEqual(['diarized_json'])
    // 30秒超の音声では chunking_strategy が必須
    expect(values(form, 'chunking_strategy')).toEqual(['auto'])
    expect(values(form, 'known_speaker_names[]')).toEqual(['自分', '相手'])
    expect(values(form, 'prompt')).toEqual([])
    expect(e.hasDiarization).toBe(true)
  })

  it('whisper-1: verbose_json ＋ セグメント時刻、language と prompt', () => {
    const e = engine('whisper-1', { prompt: 'UI用語' })
    const form = e.buildForm(Buffer.from('x'), 'c.wav')
    expect(values(form, 'response_format')).toEqual(['verbose_json'])
    expect(values(form, 'timestamp_granularities[]')).toEqual(['segment'])
    expect(values(form, 'language')).toEqual(['ja'])
    expect(values(form, 'prompt')).toEqual(['UI用語'])
    expect(e.hasTimestamps).toBe(true)
  })

  it.each(['gpt-4o-transcribe', 'gpt-4o-mini-transcribe'] as const)('%s は json と単数 language を送る', (model) => {
    const form = engine(model).buildForm(Buffer.from('x'), 'c.wav')
    expect(values(form, 'response_format')).toEqual(['json'])
    expect(values(form, 'language')).toEqual(['ja'])
    expect(values(form, 'languages[]')).toEqual([])
    expect(engine(model).hasTimestamps).toBe(false)
  })

  it('APIキーが無ければ構築時に失敗する', () => {
    expect(() => new OpenAiSttEngine({ model: 'gpt-transcribe', apiKey: '' })).toThrow(/APIキーが設定されていません/)
  })

  it('音声が端末外へ出ることを宣言する（NF-2 の判断に使う）', () => {
    expect(engine('gpt-transcribe').sendsAudioOffDevice).toBe(true)
  })
})

describe('応答のパース', () => {
  it('時刻を返さないモデルでは、チャンク全体を1区間にしてチャンクの時刻を使う', () => {
    const e = engine('gpt-transcribe')
    const segs = e.toSegments({ text: ' このボタンの色が薄いです ' }, input, 12_000)
    expect(segs).toEqual([
      {
        t0: 30_000,
        t1: 42_000,
        speaker: 'other',
        text: 'このボタンの色が薄いです',
        source: 'system',
      },
    ])
  })

  it('diarized_json のセグメントに録画開始からのオフセットを足す', () => {
    const e = engine('gpt-4o-transcribe-diarize')
    const segs = e.toSegments(
      {
        duration: 12,
        segments: [
          { id: 'seg_001', start: 0.5, end: 4.7, text: 'ここの色が薄いです', speaker: 'speaker_1' },
          { id: 'seg_002', start: 5.0, end: 8.0, text: 'じゃあ濃くしますね', speaker: 'speaker_2' },
        ],
      },
      input,
      12_000,
    )
    expect(segs.map((s) => [s.t0, s.t1, s.text, s.speakerLabel])).toEqual([
      [30_500, 34_700, 'ここの色が薄いです', 'speaker_1'],
      [35_000, 38_000, 'じゃあ濃くしますね', 'speaker_2'],
    ]);
    // useDiarizedSpeakers が false なら系統で決めた話者を使う
    expect(segs.every((s) => s.speaker === 'other')).toBe(true)
  })

  it('useDiarizedSpeakers で、話者分離のラベルを出現順に self/other へ割り当てる', () => {
    const e = engine('gpt-4o-transcribe-diarize', { useDiarizedSpeakers: true })
    const segs = e.toSegments(
      {
        segments: [
          { start: 0, end: 2, text: 'おはようございます', speaker: 'speaker_1' },
          { start: 3, end: 5, text: 'よろしくお願いします', speaker: 'speaker_2' },
          { start: 6, end: 8, text: 'では始めます', speaker: 'speaker_1' },
        ],
      },
      { ...input, speaker: 'self', source: 'mic' },
      12_000,
    )
    expect(segs.map((s) => s.speaker)).toEqual(['self', 'other', 'self'])
  })

  it('known_speaker_names を渡した場合は、その順で self/other にする', () => {
    const e = engine('gpt-4o-transcribe-diarize', {
      useDiarizedSpeakers: true,
      knownSpeakerNames: ['自分', '相手'],
    })
    const segs = e.toSegments(
      {
        segments: [
          { start: 0, end: 2, text: 'そちらはどうですか', speaker: '相手' },
          { start: 3, end: 5, text: '問題ありません', speaker: '自分' },
        ],
      },
      { ...input, speaker: 'self', source: 'mic' },
      12_000,
    )
    expect(segs.map((s) => s.speaker)).toEqual(['other', 'self'])
  })

  it('verbose_json の avg_logprob を confidence に入れる', () => {
    const e = engine('whisper-1')
    const segs = e.toSegments(
      { segments: [{ id: 0, start: 1, end: 2, text: 'はい', avg_logprob: -0.28 }] },
      input,
      12_000,
    )
    expect(segs[0]!.confidence).toBeCloseTo(-0.28)
  })

  it('空のテキストとプレースホルダを捨てる', () => {
    const e = engine('whisper-1')
    expect(
      e.toSegments({ segments: [{ start: 0, end: 1, text: '   ' }, { start: 1, end: 2, text: '（音楽）' }] }, input, 1000),
    ).toEqual([])
    expect(engine('gpt-transcribe').toSegments({ text: '' }, input, 1000)).toEqual([])
  })
})

describe('料金の概算', () => {
  it('公開価格の表', () => {
    expect(openAiSttPricePerMinuteUsd['gpt-transcribe']).toBe(0.0045)
  })
})

describe('費用上限は通信前に予約し、失敗した通信も予約を戻さない', () => {
  it('上限超過はAPIを呼ばず、1回分の予約後は再送を止める', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { vi } = await import('vitest')
    const dir = await mkdtemp(join(tmpdir(), 'ade-budget-'))
    const wavPath = join(dir, 'fixture.wav')
    await writeFile(wavPath, Buffer.from('fixture'))
    const fake = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }))
    vi.stubGlobal('fetch', fake)
    try {
      await expect(engine('gpt-transcribe', { maxCostUsd: 0.004 }).transcribeChunk({ ...input, wavPath, durationMs: 60000 })).rejects.toThrow('費用上限')
      expect(fake).not.toHaveBeenCalled()
      const limited = engine('gpt-transcribe', { maxCostUsd: 0.005 })
      await expect(limited.transcribeChunk({ ...input, wavPath, durationMs: 60000 })).rejects.toThrow('503')
      await expect(limited.transcribeChunk({ ...input, wavPath, durationMs: 60000 })).rejects.toThrow('費用上限')
      expect(fake).toHaveBeenCalledTimes(1)
    } finally { vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }) }
  })
})
