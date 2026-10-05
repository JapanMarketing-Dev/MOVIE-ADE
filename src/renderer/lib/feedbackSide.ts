import type { AppMode } from '@shared/types'

/**
 * フィードバックモードの右パネルのタブ（レビュー対象 | 文字起こし | ターミナル）。
 * ターミナルはエディタのターミナルと同じもの（同じ PTY・同じタブ）を、この右パネルへ移して見せる。
 * 新しいシェルは作らない。録画中に「localhost が起動していない」などを Agent へそのまま伝えるため
 */
export type FeedbackSideTab = 'targets' | 'transcript' | 'terminal'

/** 覚えておいた値（localStorage）を読む。知らない値・空ならレビュー対象 */
export function readFeedbackSideTab(raw: string | null): FeedbackSideTab {
  return raw === 'transcript' || raw === 'terminal' ? raw : 'targets'
}

/** 見せるタブ。文字起こしを出さない設定なら、文字起こしの代わりにレビュー対象を見せる（ターミナルはいつも出せる） */
export function shownFeedbackSideTab(tab: FeedbackSideTab, showLiveTranscript: boolean): FeedbackSideTab {
  return tab === 'transcript' && !showLiveTranscript ? 'targets' : tab
}

/**
 * ターミナル（エディタと共有の1つだけの器）を、いまどちらに置くか。
 * フィードバックモードで右パネルを開き、ターミナルのタブを見ているときだけ右パネルへ。それ以外はエディタの場所に置く
 * （エディタの画面は隠れていても DOM に残るので、xterm と PTY はそのまま生きている）
 */
export function terminalPlacement(input: { mode: AppMode; targetsOpen: boolean; shownTab: FeedbackSideTab }): 'editor' | 'feedback' {
  return input.mode === 'feedback' && input.targetsOpen && input.shownTab === 'terminal' ? 'feedback' : 'editor'
}

/**
 * エディタとフィードバックの右パネルの間で移す、ターミナルの器（App.tsx）の class。
 * xterm の器（terminalClient.ts の .terminal-host。shell.css で絶対配置）とは別の名前にする。
 * 同じ名前だと器が窓いっぱいに広がり、録画のボタンなど上の画面を覆って押せなくなった
 */
export const TERMINAL_MOUNT_CLASS = 'terminal-mount'
