/**
 * Agent の PTY へプロンプトを送るときの定数と、送り先のインタフェース。
 * 定数を1か所に置く（04_benchmark.md 3.3 の最後の行）。
 */

export { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from '@shared/bracketedPaste'
/** 送信（Enter）。本文とは別の write で送る */
export const SUBMIT = '\r'

/** 1回の write に載せる上限。これを超えたら開始→本文→終了を分けて送る */
export const MAX_SINGLE_WRITE_BYTES = 64 * 1024
/** PTY へ流すときのチャンク。間に setImmediate を挟む */
export const PTY_WRITE_CHUNK_BYTES = 16 * 1024

/**
 * 送り先の PTY。
 * Electron にも node-pty にも依存させず、関数2つだけを受け取る
 * （偽の実装で単体テストできるようにするため）。
 */
export interface AgentTerminal {
  /** PTY へ書く */
  write(data: string): void | Promise<void>
  /** PTY の出力を購読する。解除する関数を返す */
  onData(listener: (chunk: string) => void): () => void
}

/**
 * どの Agent か。状態判定ではなく「同定」にだけ使う（04_benchmark.md 3.5）。
 * `generic` は Claude Code / Codex 以外の、カタログかカスタム登録で同定できたエージェント。
 * 画面の手がかりを個別に持たないので、確認待ちと処理中だけを汎用の手がかりで見る
 */
export type AgentKind = 'claude-code' | 'codex' | 'generic' | 'unknown'

/** 検知層の状態。`done` はここに無く、表示層で導く */
export type AgentState = 'idle' | 'working' | 'blocked' | 'unknown'

/** 表示層の状態。`done` =「終わったがまだ見ていない」 */
export type DisplayState = AgentState | 'done'
