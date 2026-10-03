/**
 * セッションフォルダの構成（設計 8章）。
 *
 * <project>/.ade-movie/reviews/20261002-104012/
 * ├── feedback.md          Agentが読む本体
 * ├── 01.png …             指摘の画像
 * ├── session.json         文字起こし・LLM出力・編集結果
 * ├── events.jsonl         操作ログ
 * ├── label.json           一覧の整理（名前・アーカイブ・送った時刻）
 * ├── summary.json         一覧用の要約（session.json を保存したときに書く）
 * ├── recording.webm       動画（既定7日で自動削除）
 * └── work/                静止画・音声の中間ファイル（分解完了後に削除）
 */
import { join } from 'node:path'

export const ADE_DIR = '.ade-movie'
export const REVIEWS_DIR = 'reviews'

export interface SessionPaths {
  /** セッションID（フォルダ名）。例 20261002-104012 */
  id: string
  /** 絶対パス */
  dir: string
  /** プロジェクトからの相対パス。送信の指示文に使う（`.ade-movie/reviews/<id>`） */
  relativeDir: string
  feedbackMd: string
  sessionJson: string
  eventsJsonl: string
  /** 一覧の整理（名前・アーカイブ・送った時刻）。session.json が無い・壊れていても付けられるよう別にする */
  labelJson: string
  /** 一覧用の要約。一覧のたびに session.json と events.jsonl を読まずに済ませる（summary.ts） */
  summaryJson: string
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

export function reviewsRoot(projectDir: string): string {
  return join(projectDir, ADE_DIR, REVIEWS_DIR)
}

export function sessionPaths(projectDir: string, id: string): SessionPaths {
  const dir = join(reviewsRoot(projectDir), id)
  const workDir = join(dir, 'work')
  return {
    id,
    dir,
    relativeDir: `${ADE_DIR}/${REVIEWS_DIR}/${id}`,
    feedbackMd: join(dir, 'feedback.md'),
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

/** 画像のファイル名（`01.png`）から絶対パスを作る。feedback.md の `./01.png` に対応する */
export function imagePath(paths: SessionPaths, name: string): string {
  return join(paths.dir, name.replace(/^\.\//, ''))
}
