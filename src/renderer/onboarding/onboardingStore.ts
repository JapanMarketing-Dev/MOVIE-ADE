import { applyOnboardingPatch, type OnboardingPatch, type OnboardingState } from '@shared/onboarding'

/**
 * セットアップの進み具合を、画面ではすぐ反映し、保存は裏で順番に行う（React に依存しない。単体テストの対象）。
 *
 * 以前は保存の戻り値で閉じるかを決めていたため、保存が失敗する・戻り値に completedAt が無い
 * （main が古い・設定の読み書きの作り替え中など）と「始める」を押しても閉じなかった。
 * いまは押した時点で画面の状態を変えて閉じ、保存の結果では閉じた画面を開き直さない。
 * 保存の失敗は onError（トースト・reportHandled）で知らせるだけにする。
 */
interface OnboardingStoreDeps {
  save: (patch: OnboardingPatch) => Promise<unknown>
  onChange: (state: OnboardingState | null) => void
  onError: (err: unknown, patch: OnboardingPatch) => void
}

export class OnboardingStore {
  private queue: Promise<void> = Promise.resolve()

  constructor(private state: OnboardingState | null, private readonly deps: OnboardingStoreDeps) {}

  get current(): OnboardingState | null {
    return this.state
  }

  /** 設定を読み直したとき（起動時など）。保存の途中でも画面の値はこれで置き換える */
  reset(state: OnboardingState | null): void {
    this.state = state
    this.deps.onChange(state)
  }

  /** すぐ反映して、保存は前の保存が終わってから行う（順番が入れ替わって古い値で上書きしないように） */
  apply(patch: OnboardingPatch): Promise<void> {
    this.state = applyOnboardingPatch(this.state ?? undefined, patch) ?? null
    this.deps.onChange(this.state)
    const run = this.queue.then(() => this.deps.save(patch)).then(
      () => undefined,
      (err: unknown) => this.deps.onError(err, patch)
    )
    this.queue = run
    return run
  }
}
