/**
 * OpenAI の STT API を使う文字起こしエンジン。
 *
 * **これを使うと音声が端末外へ送信される**（NF-2 の既定方針に反する）。
 * ユーザーが明示的に選んだ場合だけ使い、UIで「音声がOpenAIへ送信される」ことを示すこと。
 *
 * 公式ドキュメント（2026-10-02 時点）で確認したモデルの違い:
 *
 * | モデル | 時刻 | 話者分離 | 料金 | 備考 |
 * |---|---|---|---|---|
 * | gpt-transcribe | **なし** | なし | $0.0045/分 | 現在の推奨モデル。`languages` / `prompt` / `keywords` が使える |
 * | gpt-4o-transcribe-diarize | セグメント単位 | **あり**（既知話者は4人まで） | $0.006/分 | `response_format=diarized_json`。30秒超は `chunking_strategy` が必須。prompt 不可 |
 * | gpt-4o-mini-transcribe | — | なし | $0.003/分 | |
 * | whisper-1 | 単語・セグメント | なし | $0.006/分 | `verbose_json` ＋ `timestamp_granularities`。prompt は224トークンまで |
 *
 * 1リクエストの上限は 25MB（全モデル共通）。16kHz モノラル16bitなら約13分。
 * 時刻を返さないモデルでは、ADE側で無音区切りにしたチャンクの時刻を使う（区間＝チャンク全体）。
 *
 * OpenAI 互換のエンドポイント（自前の GPU で動かす faster-whisper-server / speaches /
 * whisper.cpp server / vLLM、Groq など）にも同じ形式で送る。baseUrl を変えるだけで、
 * 表にないモデル名は response_format=json と language・prompt だけを送る。
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Speaker, TranscriptSegment } from '../types'
import { SttHttpError, type SttEngine, type TranscribeChunkInput, type TranscribeResult } from './engine'
import { encodeWav, wavDurationMs } from './wav'
import { DEFAULT_COST_LIMIT_USD, exceedsCostLimit, normalizeBaseUrl } from './endpoint'
import { authHeaders } from '@shared/aiProviders'
import { recordedSttFetch } from './usage'
import type { SttLanguage } from './whisper'
import { cleanText } from './whisper'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'

export type OpenAiSttModel =
  | 'gpt-transcribe'
  | 'gpt-4o-transcribe-diarize'
  | 'gpt-4o-mini-transcribe'
  | 'gpt-4o-transcribe'
  | 'whisper-1';

/** 1リクエストの上限（25MB）。余裕を持たせる */
export const OPENAI_MAX_BYTES = 25 * 1024 * 1024;

/** $/分（2026-10-02 時点の公開価格） */
export const openAiSttPricePerMinuteUsd: Record<OpenAiSttModel, number> = {
  'gpt-transcribe': 0.0045,
  'gpt-4o-transcribe-diarize': 0.006,
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-4o-transcribe': 0.006,
  'whisper-1': 0.006,
}

export interface OpenAiSttOptions {
  /** 互換サーバーでは任意のモデル名（例: Systran/faster-whisper-small, whisper-large-v3） */
  model: OpenAiSttModel | (string & {});
  /**
   * APIキー。呼び出し側（keys.ts の SttKeyStore）が渡す。環境変数は読まない
   * （配布版で開発者や環境のキーへ黙って切り替えないため）。
   * **ログ・保存ファイル・エラーメッセージに出さないこと。**
   */
  apiKey?: string;
  /** キーなしでも送る（認証のない自前サーバー） */
  keyOptional?: boolean;
  /** エラーメッセージに出す送り先の名前。既定は OpenAI */
  label?: string;
  /**
   * 'ja' など。gpt-transcribe は languages[]、whisper-1 は language。
   * `'auto'` のときは**渡さない**（OpenAI の API は未指定が自動判別。whisper.cpp と逆なので注意）。
   */
  language?: SttLanguage;
  /** 用語を与えて誤変換を減らす。gpt-4o-transcribe-diarize は非対応 */
  prompt?: string;
  /** gpt-transcribe の keywords */
  keywords?: string[];
  /**
   * 話者分離の結果をそのまま採用するか（対面MTGでマイク1本に複数人が入る場合）。
   * false なら、系統（マイク／PC音声）で決めた話者を使う。
   */
  useDiarizedSpeakers?: boolean;
  /** 既知の話者名（diarize のみ。4人まで） */
  knownSpeakerNames?: string[]
  timeoutMs?: number
  /** 例: https://api.openai.com、http://gpu-box:8000/v1。normalizeBaseUrl で揃えてから使う */
  baseUrl?: string
  /**
   * セッション単位の課金上限。投入前に音声の長さから予約する。
   * null は上限なし（料金の分からない互換サーバー向け）。省略時は DEFAULT_COST_LIMIT_USD。
   */
  maxCostUsd?: number | null
  /** 追加のヘッダー（設定の詳細）。Authorization はキーから作るので、ここでは上書きしない */
  headers?: Record<string, string>
  /** 概算の単価($/分)。省略時はモデル名の表から、null は分からない（多めの概算） */
  pricePerMinuteUsd?: number | null
  /** 提供元の id（使用量の記録に使う。groq / mistral / compatible など） */
  provider?: string
  /** 認証の形の上書き（settings.json の authScheme / authHeader）。省略時は Bearer */
  authScheme?: 'bearer' | 'header' | 'none'
  authHeader?: string
  /** file・model・language だけを送る（response_format などを受け付けない API。Mistral など） */
  minimalForm?: boolean
}

const ENDPOINT = '/v1/audio/transcriptions';

export { DEFAULT_COST_LIMIT_USD, exceedsCostLimit, normalizeBaseUrl }

/** 表にないモデル（互換サーバー）の概算に使う $/分。whisper-1 と同じ値で多めに見積もる */
export const UNKNOWN_PRICE_PER_MINUTE_USD = 0.006

/** 表にあるモデルは公開価格、ないモデルは多めの概算 */
export function sttPricePerMinuteUsd(model: string): number {
  return knownSttPricePerMinuteUsd(model) ?? UNKNOWN_PRICE_PER_MINUTE_USD
}

/** 表にあるモデルの公開価格。無ければ undefined（推測しない） */
export function knownSttPricePerMinuteUsd(model: string): number | undefined {
  return (openAiSttPricePerMinuteUsd as Record<string, number>)[model]
}
const DEFAULT_BASE_URL = 'https://api.openai.com'

/**
 * diarized_json と verbose_json のセグメントを1つの型で受ける。
 * `id` は diarized_json では文字列（"seg_001"）、verbose_json では数値なので両方許す。
 */
interface ResponseSegment {
  id?: string | number
  start?: number
  end?: number
  text?: string;
  /** diarized_json のみ */
  speaker?: string;
  /** verbose_json のみ */
  avg_logprob?: number
}

interface TranscriptionResponse {
  text?: string
  duration?: number
  segments?: ResponseSegment[]
  usage?: { type?: string; seconds?: number }
}

export class OpenAiSttEngine implements SttEngine {
  readonly id: string;
  /** 音声が端末外へ出る。UIで明示する必要がある */
  readonly sendsAudioOffDevice = true
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly label: string
  private reservedCostUsd = 0

  constructor(private readonly opt: OpenAiSttOptions) {
    const key = opt.apiKey
    if (!key && !opt.keyOptional) throw new UserFacingError(t('stt.errors.openaiKeyMissing'))
    this.apiKey = key ?? ''
    const base = normalizeBaseUrl(opt.baseUrl ?? DEFAULT_BASE_URL)
    if (!base) throw new UserFacingError(t('stt.errors.badBaseUrl'))
    this.baseUrl = base
    this.label = opt.label ?? 'OpenAI'
    this.id = `${opt.keyOptional ? 'compatible' : 'openai'}:${opt.model}`
  }

  async available(): Promise<boolean> {
    return this.apiKey.length > 0 || this.opt.keyOptional === true
  }

  /** このモデルが時刻を返すか */
  get hasTimestamps(): boolean {
    return this.opt.model === 'whisper-1' || this.opt.model === 'gpt-4o-transcribe-diarize'
  }

  /** このモデルが話者分離するか */
  get hasDiarization(): boolean {
    return this.opt.model === 'gpt-4o-transcribe-diarize'
  }

  buildForm(bytes: Buffer, name: string): FormData {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), name)
    form.append('model', this.opt.model)
    if (this.opt.minimalForm) {
      if (this.opt.language && this.opt.language !== 'auto') form.append('language', this.opt.language)
      return form
    }

    switch (this.opt.model) {
      case 'gpt-4o-transcribe-diarize':
        form.append('response_format', 'diarized_json');
        // 30秒を超える音声では必須
        form.append('chunking_strategy', 'auto')
        for (const n of this.opt.knownSpeakerNames ?? []) form.append('known_speaker_names[]', n);
        break
      case 'whisper-1':
        form.append('response_format', 'verbose_json')
        form.append('timestamp_granularities[]', 'segment')
        if (this.opt.language && this.opt.language !== 'auto') {
          form.append('language', this.opt.language)
        }
        if (this.opt.prompt) form.append('prompt', this.opt.prompt)
        break
      case 'gpt-transcribe':
        // gpt-transcribe は時刻を返さない
        form.append('response_format', 'json')
        if (this.opt.language && this.opt.language !== 'auto') {
          form.append('languages[]', this.opt.language)
        }
        if (this.opt.prompt) form.append('prompt', this.opt.prompt)
        for (const k of this.opt.keywords ?? []) form.append('keywords[]', k);
        break
      default:
        // gpt-4o(-mini)-transcribe と互換サーバーのモデル。どの実装も受け付ける最小限だけ送る
        form.append('response_format', 'json')
        if (this.opt.language && this.opt.language !== 'auto') form.append('language', this.opt.language)
        if (this.opt.prompt) form.append('prompt', this.opt.prompt)
        break
    }
    return form
  }

  async transcribeChunk(input: TranscribeChunkInput): Promise<TranscribeResult> {
    const bytes = await readFile(input.wavPath)
    if (bytes.byteLength > OPENAI_MAX_BYTES) {
      throw new Error(
        t('stt.errors.tooLarge', { size: (bytes.byteLength / 1024 / 1024).toFixed(1) }),
      )
    }
    const durationMs = input.durationMs ?? (await wavDurationMs(input.wavPath))
    // 単価が分かるか（使用量の記録に見積もりを付けるかどうか）。分からなければ上限の判定だけ多めの概算で行う
    const knownPrice = this.opt.pricePerMinuteUsd ?? (this.opt.pricePerMinuteUsd === null ? undefined : knownSttPricePerMinuteUsd(this.opt.model))
    const cost = durationMs / 60_000 * (knownPrice ?? UNKNOWN_PRICE_PER_MINUTE_USD)
    if (exceedsCostLimit(this.reservedCostUsd, cost, this.opt.maxCostUsd)) {
      throw new UserFacingError(t('stt.errors.costLimit', { label: this.label }))
    }
    this.reservedCostUsd += cost
    const form = this.buildForm(bytes, basename(input.wavPath))

    const started = Date.now()
    const res = await recordedSttFetch(`${this.baseUrl}${ENDPOINT}`, {
      method: 'POST',
      // Authorization ヘッダの値はどこにも出力しない。キーなしの自前サーバーには付けない
      headers: { ...this.opt.headers, ...authHeaders(this.opt, this.apiKey, { Authorization: `Bearer ${this.apiKey}` }) },
      body: form,
      signal: AbortSignal.timeout(this.opt.timeoutMs ?? 600_000),
    }, { provider: this.opt.provider, model: this.opt.model, durationSec: durationMs / 1000, requestBytes: bytes.byteLength,
      ...(knownPrice !== undefined ? { estimateUsd: cost } : {}) })
    const elapsedMs = Date.now() - started

    if (!res.ok) {
      // 失敗の本文は説明に使うだけ。読めなければ空で続ける（想定内）
      const body = await res.text().catch(() => '')
      const safeBody = redact(body, this.apiKey).slice(0, 500)
      throw new SttHttpError(sentence(t('stt.errors.failed', { label: this.label, status: res.status, body: safeBody })), res.status, safeBody)
    }

    const json = (await res.json()) as TranscriptionResponse
    return {
      segments: this.toSegments(json, input, durationMs),
      elapsedMs,
      commandLine: `POST ${this.baseUrl}${ENDPOINT} model=${this.opt.model}`,
      billedSeconds: json.usage?.seconds ?? Math.round(durationMs / 1000),
    }
  }

  toSegments(
    json: TranscriptionResponse,
    input: TranscribeChunkInput,
    durationMs: number,
  ): TranscriptSegment[] {
    const segs = json.segments ?? [];

    // 時刻を返すモデル
    if (segs.length > 0 && segs.some((s) => typeof s.start === 'number')) {
      const out: TranscriptSegment[] = []
      for (const s of segs) {
        const text = cleanText(s.text ?? '')
        if (!text) continue
        const t0 = input.offsetMs + Math.round((s.start ?? 0) * 1000)
        const t1 = input.offsetMs + Math.round((s.end ?? s.start ?? 0) * 1000)
        const seg: TranscriptSegment = {
          t0,
          t1: Math.max(t1, t0),
          speaker: this.resolveSpeaker(s.speaker, input.speaker),
          text,
          source: input.source,
        }
        if (s.speaker) seg.speakerLabel = s.speaker
        if (typeof s.avg_logprob === 'number') seg.confidence = s.avg_logprob
        out.push(seg)
      }
      return out
    }

    // 時刻を返さないモデル: チャンク全体を1区間にする
    const text = cleanText(json.text ?? '')
    if (!text) return []
    return [
      {
        t0: input.offsetMs,
        t1: input.offsetMs + durationMs,
        speaker: input.speaker,
        text,
        source: input.source,
      },
    ]
  }

  /** 話者分離の結果を使う設定なら、モデルのラベルを self/other へ割り当てる */
  private resolveSpeaker(label: string | undefined, fallback: Speaker): Speaker {
    if (!this.opt.useDiarizedSpeakers || !label) return fallback
    const known = this.opt.knownSpeakerNames ?? []
    const i = known.indexOf(label)
    if (i >= 0) return i === 0 ? 'self' : 'other';
    // ラベルの出現順で割り当てる（1人目=自分）
    if (!this.seen.includes(label)) this.seen.push(label)
    return this.seen.indexOf(label) === 0 ? 'self' : 'other'
  }

  private readonly seen: string[] = []
}

/** 万一キーが含まれた文字列を出す場合に備えて落とす */
export function redact(s: string, key = ''): string {
  const out = s.replace(/sk-[A-Za-z0-9_\-]{10,}/g, 'sk-***').replace(/gsk_[A-Za-z0-9]{10,}/g, 'gsk_***')
  return key.length >= 8 ? out.split(key).join('***') : out
}

/** 録画1時間あたりの概算料金(USD) */
export function estimateHourlyCostUsd(model: OpenAiSttModel, channels = 1): number {
  return openAiSttPricePerMinuteUsd[model] * 60 * channels
}

export interface SttConnectionCheck {
  ok: boolean
  /** 画面にそのまま出す日本語の結果 */
  message: string
}

/**
 * 「接続を確認」。1秒の無音（16kHz モノラル WAV）を送り、届くかどうかだけを見る。
 * 認証・URL・モデル名の誤りを、HTTP の状態と本文から日本語で言い分ける。
 * 応答本文やキーは返さない（メッセージに出すのは状態コードまで）。
 */
export async function checkSttConnection(opt: {
  baseUrl: string | undefined
  model: string
  apiKey?: string
  label?: string
  timeoutMs?: number
}): Promise<SttConnectionCheck> {
  const label = opt.label ?? 'OpenAI'
  const base = normalizeBaseUrl(opt.baseUrl)
  if (!base) return { ok: false, message: t('stt.check.badBaseUrl') }
  if (!opt.model.trim()) return { ok: false, message: t('stt.check.noModel') }
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(encodeWav(new Int16Array(16_000), 16_000))], { type: 'audio/wav' }), 'ade-check.wav')
  form.append('model', opt.model.trim())
  form.append('response_format', 'json')
  let res: Response
  try {
    res = await fetch(`${base}${ENDPOINT}`, {
      method: 'POST',
      headers: opt.apiKey ? { Authorization: `Bearer ${opt.apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(opt.timeoutMs ?? 15_000),
    })
  } catch (e) {
    const name = e instanceof Error ? e.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, message: sentence(t('stt.check.timeout', { label })) }
    return { ok: false, message: t('stt.check.unreachable', { base }) }
  }
  if (res.ok) return { ok: true, message: sentence(t('stt.check.ok', { label, model: opt.model.trim() })) }
  // 失敗の本文は説明に使うだけ（想定内）
  const body = (await res.text().catch(() => '')).slice(0, 2000)
  return { ok: false, message: describeHttpFailure(res.status, body, label) }
}

/** 接続の確認で返ってきた失敗を、利用者が直せる言葉にする（単体テストから使うため export） */
export function describeHttpFailure(status: number, body: string, label: string): string {
  const mentionsModel = /model/i.test(body)
  if (status === 401 || status === 403) return sentence(t('stt.check.auth', { label, status }))
  if ((status === 400 || status === 404 || status === 422) && mentionsModel) return sentence(t('stt.check.model', { label, status }))
  if (status === 404 || status === 405) return sentence(t('stt.check.notFound', { label, status }))
  if (status === 429) return sentence(t('stt.check.rateLimit', { label }))
  if (status >= 500) return sentence(t('stt.check.server', { label, status }))
  return t('stt.check.failed', { label, status })
}

/** 送り先の名前（英語では "the endpoint"）で始まる文の先頭を大文字にする。日本語には影響しない */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
