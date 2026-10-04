/**
 * 端末内の Ollama で動かすモデルを、PC のメモリ（と分かれば GPU）から選ぶ。main が os.totalmem() などで HardwareInfo を作り、
 * 判定モデル（clef / clef-flash）と「指摘の整理」（gpt-oss / qwen3）の既定に使う。画面には結果だけを渡す（SttAvailability.localModels）。
 *
 * 根拠（2026-10-03 に ollama.com/library の各モデルの tags で確認したダウンロードの大きさ。読み込むとほぼこの大きさ＋文脈の分を食う）:
 *   clef:27b（q4_k_m）18GB / clef-flash:9b 11GB / gpt-oss:20b 14GB / gpt-oss:120b 65GB / qwen3:8b 5.2GB
 * 決め方:
 *   - Apple Silicon はメモリを GPU と分け合う。Metal が GPU に回すのは既定で物理メモリの約2/3（大きい機種で約3/4）なので、
 *     モデル＋文脈（数GB）がその中に収まり、さらに Ferret・Agent・開発サーバー・ブラウザの分（8〜12GB）が残る大きさから選ぶ
 *   - NVIDIA の GPU は VRAM に丸ごと載るかで選ぶ（nvidia-smi で分かったときだけ）。載らないと CPU と分け合って遅くなる
 *   - それ以外（Intel Mac・GPU の無い PC）は CPU で動くので、遅くならない小さい方を選ぶ
 * 載らない・難しい環境は clef-flash（判定）・qwen3:8b（整理）にする。メモリが少なすぎても止めない（遅いだけで動く）。
 */

export interface HardwareInfo {
  /** 物理メモリ（バイト。os.totalmem()） */
  totalMemBytes: number
  platform: string
  arch: string
  /** os.cpus()[0].model（Rosetta で x64 の版を動かしていても Apple Silicon と分かる） */
  cpuModel?: string
  /** NVIDIA の GPU の VRAM（バイト。いちばん大きいもの）。分からなければ省略 */
  gpuVramBytes?: number
}

type DecisionLocalModel = 'clef' | 'clef-flash'

export interface LocalModelRecommendation {
  /** 判定モデル（System One 互換。画像を読む） */
  decision: DecisionLocalModel
  /** 「指摘の整理」を Ollama で動かすときのモデル */
  organize: string
}

const GiB = 1024 ** 3

/** clef を選ぶ下限。Apple Silicon の物理メモリ（約2/3の24GB に 18GB＋文脈が収まり、ほかに 12GB 残る） */
const CLEF_MIN_UNIFIED_GIB = 36
/** clef を選ぶ下限。NVIDIA の VRAM（24GB の板は 23.99GiB と出るので少し下げる） */
const CLEF_MIN_VRAM_GIB = 22
/** gpt-oss:20b を選ぶ下限（Apple Silicon・VRAM・CPU）。MoE で動く部分が小さいので CPU でも使える速さ */
const GPT_OSS_20B_MIN_UNIFIED_GIB = 32
const GPT_OSS_20B_MIN_VRAM_GIB = 15
const GPT_OSS_20B_MIN_CPU_RAM_GIB = 32
/** gpt-oss:120b を選ぶ下限（65GB） */
const GPT_OSS_120B_MIN_UNIFIED_GIB = 128
const GPT_OSS_120B_MIN_VRAM_GIB = 78

export function isAppleSilicon(hw: Pick<HardwareInfo, 'platform' | 'arch' | 'cpuModel'>): boolean {
  return hw.platform === 'darwin' && (hw.arch === 'arm64' || /^Apple M\d/i.test(hw.cpuModel ?? ''))
}

const gib = (bytes: number | undefined): number => (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes / GiB : 0)

/** 判定モデル。clef が無理なく載るときだけ clef、それ以外は clef-flash */
export function recommendDecisionModel(hw: HardwareInfo): DecisionLocalModel {
  const ram = gib(hw.totalMemBytes)
  if (isAppleSilicon(hw)) return ram >= CLEF_MIN_UNIFIED_GIB ? 'clef' : 'clef-flash'
  return gib(hw.gpuVramBytes) >= CLEF_MIN_VRAM_GIB && ram >= 16 ? 'clef' : 'clef-flash'
}

/** 整理のモデル（Ollama のモデル名） */
export function recommendOrganizeModel(hw: HardwareInfo): string {
  const ram = gib(hw.totalMemBytes)
  const vram = gib(hw.gpuVramBytes)
  if (isAppleSilicon(hw)) {
    if (ram >= GPT_OSS_120B_MIN_UNIFIED_GIB) return 'gpt-oss:120b'
    return ram >= GPT_OSS_20B_MIN_UNIFIED_GIB ? 'gpt-oss:20b' : 'qwen3:8b'
  }
  if (vram >= GPT_OSS_120B_MIN_VRAM_GIB) return 'gpt-oss:120b'
  return vram >= GPT_OSS_20B_MIN_VRAM_GIB || ram >= GPT_OSS_20B_MIN_CPU_RAM_GIB ? 'gpt-oss:20b' : 'qwen3:8b'
}

export function recommendLocalModels(hw: HardwareInfo): LocalModelRecommendation {
  return { decision: recommendDecisionModel(hw), organize: recommendOrganizeModel(hw) }
}

/**
 * nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits の出力（1行に1枚、MiB）から、いちばん大きい VRAM（バイト）。
 * 読めなければ undefined
 */
export function parseNvidiaSmiVram(stdout: string): number | undefined {
  const mibs = stdout.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isFinite(n) && n > 0)
  return mibs.length ? Math.max(...mibs) * 1024 * 1024 : undefined
}

/** 推奨の印を付け替えたモデル一覧（推奨が一覧に無ければ先頭に足す）。設定の画面が「推奨」を出すのに使う */
export function withRecommendedModel<M extends { id: string; recommended?: true }>(models: readonly M[], id: string | undefined): M[] {
  if (!id) return [...models]
  const marked = models.map((m) => {
    const { recommended: _r, ...rest } = m
    return (m.id === id ? { ...rest, recommended: true } : rest) as M
  })
  return marked.some((m) => m.id === id) ? marked : [{ id, recommended: true } as M, ...marked]
}
