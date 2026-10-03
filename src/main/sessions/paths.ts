/**
 * セッションフォルダの構成（設計 8章）。
 *
 * <project>/.ferret/reviews/20261002-104012/
 * ├── feedback.md          Agentが読む本体
 * ├── 01.png …             指摘の画像
 * ├── session.json         文字起こし・LLM出力・編集結果
 * ├── events.jsonl         操作ログ
 * ├── label.json           一覧の整理（名前・アーカイブ・送った時刻）
 * ├── summary.json         一覧用の要約（session.json を保存したときに書く）
 * ├── progress.json        指摘ごとの進み具合（Agent と利用者が書く。@shared/findingProgress）
 * ├── recording.webm       動画（既定7日で自動削除）
 * ├── work/                静止画・音声の中間ファイル（分解完了後に削除）
 * └── takes/2/ …           あとから追記した録画（sessions/takes.ts）。中は上と同じ形
 *                          （recording.webm・events.jsonl・transcript.jsonl・capture.json・work/）
 */
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const ADE_DIR = '.ferret'
/**
 * 改名前（MOVIE-ADE）のフォルダ。新しくは書かないが、履歴に出し続ける（利用者のファイルは黙って移さない）。
 * 同じ ID が両方にあれば .ferret/ を使う
 */
export const LEGACY_ADE_DIR = '.ade-movie'
export const REVIEWS_DIR = 'reviews'

export interface SessionPaths {
  /** セッションID（フォルダ名）。例 20261002-104012 */
  id: string
  /** 絶対パス */
  dir: string
  /** プロジェクトからの相対パス。送信の指示文に使う（`.ferret/reviews/<id>`。古いレビューは `.ade-movie/reviews/<id>`） */
  relativeDir: string
  feedbackMd: string
  sessionJson: string
  eventsJsonl: string
  /** 一覧の整理（名前・アーカイブ・送った時刻）。session.json が無い・壊れていても付けられるよう別にする */
  labelJson: string
  /** 一覧用の要約。一覧のたびに session.json と events.jsonl を読まずに済ませる（summary.ts） */
  summaryJson: string
  /** 指摘ごとの進み具合。Agent が作業しながら書く（progress.ts） */
  progressJson: string
  recording: string
  workDir: string
  /** 音声チャンクの置き場所（work/audio） */
  audioDir: string
  /** 静止画の置き場所（work/frames） */
  framesDir: string
}

/** 日時からセッションIDを作る。ローカル時刻の `YYYYMMDD-HHMMSS` */
export function sessionId(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/** セッションIDとして妥当か（フォルダ一覧の読み込みで使う） */
export function isSessionId(name: string): boolean {
  return /^\d{8}-\d{6}$/.test(name)
}

export function reviewsRoot(projectDir: string, base: string = ADE_DIR): string {
  return join(projectDir, base, REVIEWS_DIR)
}

/** レビューを探すフォルダ（新しい順の優先度: .ferret/ → .ade-movie/） */
export function reviewsRoots(projectDir: string): string[] {
  return [reviewsRoot(projectDir, ADE_DIR), reviewsRoot(projectDir, LEGACY_ADE_DIR)]
}

/** 両方のフォルダにあるセッションID（重複は1つ）。まだ録画していないプロジェクトにはフォルダが無い（想定内） */
export async function listSessionIds(projectDir: string): Promise<string[]> {
  const ids = new Set<string>()
  for (const root of reviewsRoots(projectDir)) {
    for (const name of await readdir(root).catch(() => [] as string[])) if (isSessionId(name)) ids.add(name)
  }
  return [...ids]
}

/**
 * セッションのパス。base を省くと、.ferret/ に無く .ade-movie/ にだけあるものは .ade-movie/ を指す（古いレビューを読む）。
 * 新しく作るときは base に ADE_DIR を渡す（store.ts の createSession）
 */
export function sessionPaths(projectDir: string, id: string, base?: string): SessionPaths {
  const folder = base ?? (!existsSync(join(reviewsRoot(projectDir, ADE_DIR), id)) && existsSync(join(reviewsRoot(projectDir, LEGACY_ADE_DIR), id)) ? LEGACY_ADE_DIR : ADE_DIR)
  const dir = join(reviewsRoot(projectDir, folder), id)
  const workDir = join(dir, 'work')
  return {
    id,
    dir,
    relativeDir: `${folder}/${REVIEWS_DIR}/${id}`,
    feedbackMd: join(dir, 'feedback.md'),
    sessionJson: join(dir, 'session.json'),
    eventsJsonl: join(dir, 'events.jsonl'),
    labelJson: join(dir, 'label.json'),
    summaryJson: join(dir, 'summary.json'),
    progressJson: join(dir, 'progress.json'),
    recording: join(dir, 'recording.webm'),
    workDir,
    audioDir: join(workDir, 'audio'),
    framesDir: join(workDir, 'frames')
  }
}

/** 画像のファイル名（`01.png`）から絶対パスを作る。feedback.md の `./01.png` に対応する */
export function imagePath(paths: SessionPaths, name: string): string {
  return join(paths.dir, name.replace(/^\.\//, ''))
}

export const TAKES_DIR = 'takes'

/**
 * 追記した録画（2 本目から）の置き場所。ID と送信の指示文はレビューのものを使い、ファイルだけ takes/<n>/ に分ける。
 * n が 1 ならレビューそのもの
 */
export function takePaths(paths: SessionPaths, n: number): SessionPaths {
  if (n <= 1) return paths
  const dir = join(paths.dir, TAKES_DIR, String(n))
  const workDir = join(dir, 'work')
  return {
    ...paths,
    dir,
    sessionJson: join(dir, 'session.json'),
    eventsJsonl: join(dir, 'events.jsonl'),
    labelJson: join(dir, 'label.json'),
    summaryJson: join(dir, 'summary.json'),
    recording: join(dir, 'recording.webm'),
    workDir,
    audioDir: join(workDir, 'audio'),
    framesDir: join(workDir, 'frames')
  }
}

/** 追記した録画の静止画は `takes/<n>/<ファイル名>` の形で session.json の frames に入れる（最初の録画はファイル名だけ） */
const TAKE_FRAME = /^takes\/(\d+)\/([^/\\]+)$/

/** session.json の静止画のパス（FrameRef.path）から、実際のファイルの絶対パスを作る */
export function frameFilePath(paths: SessionPaths, framePath: string): string {
  const take = TAKE_FRAME.exec(framePath)
  if (take) return join(takePaths(paths, Number(take[1])).framesDir, take[2]!)
  return join(paths.framesDir, basename(framePath))
}
