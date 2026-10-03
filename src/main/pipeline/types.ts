/**
 * 分解パイプラインの型。
 * 時刻はすべて「録画開始からのミリ秒」（03_design.md 4章の同じ時計）。
 */

// ───────────────────────── 文字起こし ─────────────────────────

/** マイク系統＝自分、PC音声系統＝相手（02_requirements.md AUD-2） */
export type Speaker = 'self' | 'other';

/** 音声の取得系統。話者の区別をしない運用（対面・マイク1本）では 'mic' のみになる */
export type AudioSource = 'mic' | 'system'

export interface TranscriptSegment {
  /** 開始（録画開始からのms） */
  t0: number;
  /** 終了（録画開始からのms） */
  t1: number
  speaker: Speaker
  text: string;
  /** どの系統から出たか。二重取りの除去で使う */
  source?: AudioSource;
  /** whisper の平均対数確率（あれば）。低信頼の判定に使える */
  confidence?: number;
  /**
   * 話者分離モデルが付けた生のラベル（例 'speaker_1'）。
   * マイク1本に複数人が入る場合に、speaker（self/other）だけでは表せない区別を保持する。
   */
  speakerLabel?: string
}

// ───────────────────────── 操作ログ ─────────────────────────

export interface ElementRef {
  selector: string
  /** 要素の表示テキスト */
  text?: string
  /**
   * 入力欄の値など、出力してはいけない文字列か（NF-14）。
   * 注入スクリプトが `input[type=password]` などを見て立てる。
   * 立っていれば `text` は feedback.md に出さない。
   */
  sensitive?: boolean
}

export interface NavEvent {
  t: number
  type: 'nav'
  url: string
  title: string;
  /** 表示幅(px)。PC/スマホ切替（WS-3） */
  viewport?: number
}

/**
 * 座標を記録した時点のビューの大きさ（CSSピクセル）。
 * 表示幅を切り替える（WS-3）ため、ピクセル座標だけでは後から解釈できない。
 * これと併記することで 0〜1 の相対座標に直せる（04_benchmark.md 3.9）。
 */
export interface ViewSize {
  width: number
  height: number
}

export interface ClickEvent {
  t: number
  type: 'click'
  x: number
  y: number
  /** この時点のビューの大きさ。無いと座標を再解釈できない */
  view?: ViewSize
  el?: ElementRef
}

export interface ScrollEvent {
  t: number
  type: 'scroll'
  y: number
}

/** ペン書き込み1本。id は feedback.md / LLM 出力から参照される */
export interface PenEvent {
  t: number
  type: 'pen'
  id: string;
  /** 書き終わった時刻（＝画像にすべき時刻） */
  t_end: number;
  /** [x, y, w, h] */
  bbox: [number, number, number, number]
  /** この時点のビューの大きさ */
  view?: ViewSize
  el?: ElementRef
}

/** 画面に置かれたテキスト（TXT-1）。それ自体が1つの指摘になりうる */
export interface TextEvent {
  t: number
  type: 'text'
  id: string
  x: number
  y: number
  body: string
  /** この時点のビューの大きさ */
  view?: ViewSize
  el?: ElementRef
}

/** 表示幅の切替（WS-3）。nav をまたいで保持される */
export interface ViewportEvent {
  t: number
  type: 'viewport'
  width: number
}

export type Event = NavEvent | ClickEvent | ScrollEvent | PenEvent | TextEvent | ViewportEvent;

/** ペン・テキストをまとめて「書き込み（annotation）」と呼ぶ */
export type Annotation = PenEvent | TextEvent

export function isAnnotation(e: Event): e is Annotation {
  return e.type === 'pen' || e.type === 'text'
}

/** 書き込みが画像として確定する時刻 */
export function annotationFrameTime(a: Annotation): number {
  return a.type === 'pen' ? a.t_end : a.t
}

// ───────────────────────── 静止画 ─────────────────────────

export interface FrameRef {
  /** この画像に描画済みのペン・テキストのID（直前の未確定画像を選ばないため） */
  annotationId?: string
  /** 撮影時刻 */
  t: number;
  /** work/ 以下の相対パスなど。パイプラインは中身を読まない */
  path: string;
  /** カーソル位置（リング合成用。EXT-3） */
  cursor?: { x: number; y: number }
  /** この静止画の大きさ（ピクセル）。座標をこの画像に重ねるときに使う */
  size?: ViewSize
}

// ───────────────────────── 録画セッション ─────────────────────────

export interface SessionMeta {
  /** セッションID（フォルダ名）。例 20261002-104012 */
  id: string;
  /** 収録開始の実時刻（ISO8601） */
  startedAt: string;
  /** 録画の長さ(ms) */
  durationMs: number;
  /** 代表URL（最初の nav） */
  targetUrl?: string;
  /** 相手の声も録ったか。MTGモードの判定に使う（EXT-7） */
  twoSpeakers: boolean
  /**
   * 録画を始めた時点のプロジェクトの登録URL（local / dev / prd）。
   * 指摘を対象ごとにまとめるとき、URL に環境のラベルを付けるのに使う（shared/reviewTarget.ts）
   */
  urlPresets?: Array<{ id: string; label: string; url: string }>
}

/** 分解の入力一式（①素材化の結果） */
export interface Material {
  meta: SessionMeta
  transcript: TranscriptSegment[]
  events: Event[]
  frames: FrameRef[]
}

// ───────────────────────── ②下書き（ルール） ─────────────────────────

export interface DraftItem {
  /** d1, d2 … */
  id: string;
  /** 指摘の開始時刻 */
  t: number;
  /** 指摘の終了時刻 */
  tEnd: number;
  /** この指摘に属する発話（原文のまま） */
  segments: TranscriptSegment[];
  /** 紐づいたペン・テキストのID */
  annotationIds: string[];
  /** 画像にする静止画の時刻（最大3枚） */
  frameTimes: number[];
  /** 発話起点か、書き込み単独か */
  origin: 'speech' | 'annotation'
}

export interface Draft {
  items: DraftItem[]
}

// ───────────────────────── ③整理（LLM） ─────────────────────────

/** LLM へ渡す入力（テキストのみ。画像は既定で渡さない。NF-2 / 設計5章③） */
export interface OrganizeInput {
  meta: SessionMeta
  transcript: TranscriptSegment[]
  events: Event[];
  /** 静止画の「時刻一覧」だけを渡す（画像そのものは渡さない） */
  frameTimes: number[]
  draft: DraftItem[]
}

export type ItemStatus = 'decided' | 'needs_check'

export interface Quote {
  source?: 'text'
  speaker: Speaker
  t: number
  text: string
}

export interface OrganizedItem {
  title: string
  request: string
  status: ItemStatus
  quotes: Quote[]
  frame_times: number[]
  annotation_ids: string[]
}

export interface DroppedUtterance {
  t: number
  text: string
  reason: string
}

/** LLM の出力（JSON Schema で検証する形） */
export interface OrganizeOutput {
  items: OrganizedItem[]
  dropped: DroppedUtterance[]
}

// ───────────────────────── ④出力 ─────────────────────────

/** 機械的に付ける文脈（EXT-4。LLM には書かせない） */
export interface ItemContext {
  url?: string
  title?: string
  viewport?: number;
  /** 指した要素 */
  element?: ElementRef;
  /** 直前の操作の説明（例「トップ →「料金」をクリック」） */
  priorOps?: string
}

/** 確認画面・feedback.md が扱う最終の指摘 */
export interface FeedbackItem {
  /** 編集をまたいで変わらないID。確認画面の操作はこれで指す */
  id: string
  /** 1 から始まる通し番号（時刻順。編集のたびに振り直す） */
  index: number;
  /** 指摘の代表時刻（見出しの [00:14]） */
  t: number
  title: string
  request: string
  status: ItemStatus
  quotes: Quote[];
  /** 画像の相対パス（./01.png など）。frameTimes と同じ順 */
  images: string[];
  /** images に対応する静止画の時刻。画像差し替え（REV-3）と保存で使う */
  frameTimes: number[];
  /** context を引いた時刻（画像の時刻）。画像差し替え時に context を引き直すのに使う */
  contextTime: number
  context: ItemContext;
  /** 由来の下書きID（トレース用） */
  draftIds: string[];
  /** 紐づくペン・テキストのID。画像を差し替えたときに文脈を引き直すのに使う */
  annotationIds: string[]
  /** 送信対象に含めるか（REV-2。要確認を外せる） */
  include: boolean
}

export interface FeedbackDocument {
  meta: SessionMeta
  items: FeedbackItem[]
  dropped: DroppedUtterance[];
  /** 全体への補足コメント（REV-5） */
  note?: string;
  /** 整理に LLM を使えたか。false ならルール下書きのまま（EXT-11） */
  organizedByLlm: boolean
}

/** ピクセル座標を 0〜1 の相対座標に直す（表示幅を切り替えても解釈できる形。NF-14 の隣の課題） */
export function toRelativePoint(
  point: { x: number; y: number },
  view: ViewSize | undefined
): { x: number; y: number } | undefined {
  if (!view || view.width <= 0 || view.height <= 0) return undefined
  return { x: point.x / view.width, y: point.y / view.height }
}
