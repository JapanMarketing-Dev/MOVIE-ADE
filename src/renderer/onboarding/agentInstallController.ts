import { installOutcome, type InstallOutcome } from '@shared/agentInstall'
import { errorMessage } from '../lib/errors'

/**
 * Agent の CLI のインストールを1枚のカードで動かす状態機械（React に依存しない。単体テストの対象）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/onboarding/OnboardingInlineCommandTerminal.tsx の
 *           「1回きりのシェルを作ってコマンドを流し、終わりを受け取り、外したら必ず閉じる」流れ（MIT）と、
 *           FeatureSetupInlineTerminal.tsx の「終わったら検出し直す」（onTerminalExit → notifyInstalledAgentSkillsChanged）。
 *
 * 守ること:
 *   - start() を呼ばれるまで何もしない（自動では動かさない）
 *   - 1枚のカードで同時に動かすのは1つだけ（動いている間の start() は無視する）
 *   - 中止・外す（dispose）ときは PTY を必ず閉じる。作っている途中に外されたら、できた時点で閉じる
 *   - 成功したら検出し直す（agents:list(refresh)）。カードが「インストール済み」に変わるかは結果次第
 */

export type InstallState =
  | { phase: 'idle'; run: number }
  | { phase: 'starting'; run: number }
  | { phase: 'running'; run: number; ptyId: string }
  | { phase: 'done'; run: number; outcome: InstallOutcome; exitCode: number | null; detected: boolean | null }
  | { phase: 'cancelled'; run: number }
  | { phase: 'error'; run: number; message: string }

export interface InstallDeps {
  /** 終わったら閉じるシェルを作り、command を流す。PTY の id を返す */
  create: (command: string, run: number) => Promise<string>
  close: (ptyId: string) => void
  /** PTY の終了（terminal:exit）を聞く。外す関数を返す */
  onExit: (listener: (ptyId: string, exitCode: number) => void) => () => void
  /** 検出し直す。その Agent が見つかったら true */
  refresh: () => Promise<boolean>
}

export function isInstallBusy(state: InstallState): boolean {
  return state.phase === 'starting' || state.phase === 'running'
}

export class AgentInstallController {
  private current: InstallState = { phase: 'idle', run: 0 }
  private readonly offExit: () => void
  /** 作り終わる前に終わった PTY（短いコマンドでは create の戻りより先に exit が届くことがある） */
  private readonly earlyExits = new Map<string, number>()
  private disposed = false

  constructor(
    private readonly command: string,
    private readonly deps: InstallDeps,
    private readonly onChange: (state: InstallState) => void = () => undefined
  ) {
    this.offExit = deps.onExit((ptyId, exitCode) => this.handleExit(ptyId, exitCode))
  }

  get state(): InstallState {
    return this.current
  }

  private set(next: InstallState): void {
    this.current = next
    if (!this.disposed) this.onChange(next)
  }

  /** 利用者が「インストール」「もう一度」を押したときだけ呼ぶ */
  start(): void {
    if (this.disposed || isInstallBusy(this.current)) return
    const run = this.current.run + 1
    this.set({ phase: 'starting', run })
    this.deps.create(this.command, run).then(
      (ptyId) => {
        // 作っている間に中止・外された、または次の実行が始まった。できたシェルはすぐ閉じる
        if (this.disposed || this.current.run !== run || this.current.phase !== 'starting') {
          this.deps.close(ptyId)
          return
        }
        const early = this.earlyExits.get(ptyId)
        this.earlyExits.delete(ptyId)
        this.set({ phase: 'running', run, ptyId })
        if (early !== undefined) this.handleExit(ptyId, early)
      },
      (err: unknown) => {
        if (this.disposed || this.current.run !== run) return
        // IPC の包み（Error invoking remote method '…': Error:）を外して本文だけを出す
        this.set({ phase: 'error', run, message: errorMessage(err) })
      }
    )
  }

  /** 中止。PTY を閉じる（届く終了は無視する） */
  cancel(): void {
    const state = this.current
    if (state.phase === 'running') this.deps.close(state.ptyId)
    if (isInstallBusy(state)) this.set({ phase: 'cancelled', run: state.run })
  }

  /** カードを閉じた・手順を移った・セットアップを閉じた。動いていれば止める */
  dispose(): void {
    if (this.disposed) return
    const state = this.current
    if (state.phase === 'running') this.deps.close(state.ptyId)
    this.disposed = true
    this.offExit()
  }

  private handleExit(ptyId: string, exitCode: number): void {
    const state = this.current
    if (state.phase === 'starting') {
      this.earlyExits.set(ptyId, exitCode)
      return
    }
    if (state.phase !== 'running' || state.ptyId !== ptyId) return
    const outcome = installOutcome(exitCode)
    this.set({ phase: 'done', run: state.run, outcome, exitCode, detected: null })
    if (outcome !== 'success') return
    const run = state.run
    void this.deps.refresh().then(
      (detected) => {
        const now = this.current
        if (now.phase === 'done' && now.run === run) this.set({ ...now, detected })
      },
      () => undefined
    )
  }
}
