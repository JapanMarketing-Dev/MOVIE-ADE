import { describe, expect, it } from 'vitest'
import {
  chooseWhisperModel,
  detectGpu,
  detectLlmAvailability,
  detectLlmRuntime,
  isWhisperModelReady,
  resolveWhisperBinary,
  resolveWhisperRuntime,
  whisperModelPath
} from '../../src/main/pipeline/environment'
import type { EnvironmentProbes } from '../../src/main/pipeline/environment'

/** 既定は「何も見つからない」。テストごとに必要なものだけ生やす */
function probes(overrides: Partial<EnvironmentProbes> = {}): EnvironmentProbes {
  return {
    platform: 'darwin',
    arch: 'arm64',
    exists: () => false,
    which: () => null,
    ...overrides
  }
}

const paths = { modelDir: '/userdata/models' }

describe('whisper の実行ファイルを探す', () => {
  it('同梱したものを最優先で使う（配布時）', () => {
    const found = resolveWhisperBinary(
      { ...paths, resourcesDir: '/app/resources' },
      probes({
        exists: (p) => p === '/app/resources/whisper/darwin-arm64/whisper-cli',
        which: () => '/opt/homebrew/bin/whisper-cli'
      })
    )
    expect(found).toBe('/app/resources/whisper/darwin-arm64/whisper-cli')
  })

  it('Windows では .exe を探す', () => {
    const found = resolveWhisperBinary(
      { ...paths, resourcesDir: 'C:\\app\\resources' },
      probes({
        platform: 'win32',
        arch: 'x64',
        exists: (p) => p === 'C:\\app\\resources\\whisper\\win32-x64\\whisper-cli.exe'
      })
    )
    expect(found).toBe('C:\\app\\resources\\whisper\\win32-x64\\whisper-cli.exe')
  })

  it('同梱が無ければ PATH 上のものを使う（開発時）', () => {
    const found = resolveWhisperBinary(paths, probes({ which: () => '/usr/local/bin/whisper-cli' }))
    expect(found).toBe('/usr/local/bin/whisper-cli')
  })

  it('PATH に無ければ Homebrew の既定の場所を見る', () => {
    const found = resolveWhisperBinary(
      paths,
      probes({ exists: (p) => p === '/opt/homebrew/bin/whisper-cli' })
    )
    expect(found).toBe('/opt/homebrew/bin/whisper-cli')
  })

  it('どこにも無ければ null', () => {
    expect(resolveWhisperBinary(paths, probes())).toBeNull()
  })
})

describe('モデルの置き場所', () => {
  it('ユーザー設定フォルダの下に置く（プロジェクトを汚さない。NF-9）', () => {
    expect(whisperModelPath(paths, 'large-v3-turbo')).toBe(
      '/userdata/models/ggml-large-v3-turbo.bin'
    )
    expect(whisperModelPath(paths, 'small')).toBe('/userdata/models/ggml-small.bin')
  })

  it('ダウンロード済みかを判定できる', () => {
    const p = probes({ exists: (x) => x === '/userdata/models/ggml-small.bin' })
    expect(isWhisperModelReady(paths, 'small', p)).toBe(true)
    expect(isWhisperModelReady(paths, 'large-v3-turbo', p)).toBe(false)
  })
})

describe('GPUの判定とモデルの既定', () => {
  it('whisper-cli が読み込んだバックエンドから判定する', async () => {
    const metal = await detectGpu(
      '/bin/whisper-cli',
      probes({ run: async () => 'load_backend: loaded MTL backend from /opt/...' })
    )
    expect(metal).toBe(true)

    const cuda = await detectGpu(
      '/bin/whisper-cli',
      probes({ platform: 'linux', run: async () => 'load_backend: loaded CUDA backend' })
    )
    expect(cuda).toBe(true)

    const cpuOnly = await detectGpu(
      '/bin/whisper-cli',
      probes({ platform: 'linux', run: async () => 'load_backend: loaded CPU backend' })
    )
    expect(cpuOnly).toBe(false)
  })

  it('実行できない場合は、macOS だけ GPU ありとみなす（控えめな既定）', async () => {
    expect(await detectGpu('/bin/whisper-cli', probes({ run: async () => null }))).toBe(true)
    expect(
      await detectGpu('/bin/whisper-cli', probes({ platform: 'win32', run: async () => null }))
    ).toBe(false)
    // 実行ファイル自体が無い場合も既定で判断する
    expect(await detectGpu(null, probes({ platform: 'linux' }))).toBe(false)
  })

  it('CPUのみなら small を既定にする（large-v3-turbo は逐次処理が追いつかない）', () => {
    expect(chooseWhisperModel(true)).toBe('large-v3-turbo')
    expect(chooseWhisperModel(false)).toBe('small')
  })
})

describe('whisper の実行環境をまとめて解決する', () => {
  it('実行ファイル・モデル・GPU・未ダウンロードを一度に返す', async () => {
    const runtime = await resolveWhisperRuntime(
      paths,
      probes({
        which: () => '/opt/homebrew/bin/whisper-cli',
        run: async () => 'loaded MTL backend'
      })
    )
    expect('error' in runtime).toBe(false)
    if ('error' in runtime) return
    expect(runtime.binary).toBe('/opt/homebrew/bin/whisper-cli')
    expect(runtime.gpuAvailable).toBe(true)
    expect(runtime.modelId).toBe('large-v3-turbo')
    expect(runtime.needsDownload).toBe(true)
  })

  it('CPUのみの端末では small になる', async () => {
    const runtime = await resolveWhisperRuntime(
      paths,
      probes({
        platform: 'win32',
        which: () => 'C:\\tools\\whisper-cli.exe',
        run: async () => 'loaded CPU backend'
      })
    )
    if ('error' in runtime) throw new Error('解決できるはず')
    expect(runtime.modelId).toBe('small')
    expect(runtime.gpuAvailable).toBe(false)
  })

  it('モデルが既にあれば needsDownload は false', async () => {
    const runtime = await resolveWhisperRuntime(
      paths,
      probes({
        which: () => '/bin/whisper-cli',
        exists: (p) => p === '/userdata/models/ggml-large-v3-turbo.bin',
        run: async () => 'loaded MTL backend'
      })
    )
    if ('error' in runtime) throw new Error('解決できるはず')
    expect(runtime.needsDownload).toBe(false)
  })

  it('設定でモデルを明示したらそれに従う', async () => {
    const runtime = await resolveWhisperRuntime(
      paths,
      probes({ which: () => '/bin/whisper-cli', run: async () => 'loaded MTL backend' }),
      { modelId: 'small' }
    )
    if ('error' in runtime) throw new Error('解決できるはず')
    expect(runtime.modelId).toBe('small')
  })

  it('実行ファイルが無ければ error を返す（例外にしない）', async () => {
    const runtime = await resolveWhisperRuntime(paths, probes())
    expect(runtime).toEqual({ error: 'binary-not-found' })
  })
})

describe('LLM CLI の検出（設計6章）', () => {
  const both = probes({
    which: (c) => (c === 'codex' ? '/bin/codex' : c === 'claude' ? '/bin/claude' : null)
  })

  it('既定は Codex（所要時間が安定）', async () => {
    const runtime = await detectLlmRuntime(both)
    expect(runtime).toEqual({ kind: 'codex', binary: '/bin/codex' })
  })

  it('Codex が無ければ Claude Code の sonnet', async () => {
    const runtime = await detectLlmRuntime(
      probes({ which: (c) => (c === 'claude' ? '/bin/claude' : null) })
    )
    expect(runtime).toEqual({ kind: 'claude-code', binary: '/bin/claude', model: 'sonnet' })
  })

  it('設定で選ばれていればそちらを使う', async () => {
    expect((await detectLlmRuntime(both, 'claude-code'))?.kind).toBe('claude-code')
  })

  it('設定で選ばれたものが無ければ、使えるほうへ落とす', async () => {
    const runtime = await detectLlmRuntime(
      probes({ which: (c) => (c === 'claude' ? '/bin/claude' : null) }),
      'codex'
    )
    expect(runtime?.kind).toBe('claude-code')
  })

  it('どちらも無ければ null（下書きだけで進める。EXT-11）', async () => {
    expect(await detectLlmRuntime(probes())).toBeNull()
  })

  it('一覧表示のために両方の有無を返す', async () => {
    expect(await detectLlmAvailability(both)).toEqual({ codex: true, claudeCode: true })
    expect(await detectLlmAvailability(probes())).toEqual({ codex: false, claudeCode: false })
  })
})
