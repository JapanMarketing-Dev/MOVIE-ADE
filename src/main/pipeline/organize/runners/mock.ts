/** テスト用の runner。固定の出力を返すので CLI を呼ばずに整理の経路を試せる。 */
import { delay } from '@shared/delay'
import type { LlmRunner, RunnerRequest, RunnerResult } from '../runner'
import { RunnerError } from '../runner'

export class MockRunner implements LlmRunner {
  readonly id = 'mock';
  /** 実行時に渡されたリクエスト（アサーション用） */
  readonly calls: RunnerRequest[] = []

  constructor(
    private readonly behavior:
      | { kind: 'raw'; raw: string }
      | { kind: 'error'; error: RunnerError }
      | { kind: 'hang' },
  ) {}

  async available(): Promise<boolean> {
    return true
  }

  async run(req: RunnerRequest): Promise<RunnerResult> {
    this.calls.push(req)
    if (this.behavior.kind === 'error') throw this.behavior.error
    if (this.behavior.kind === 'hang') {
      await delay(req.timeoutMs + 50)
      throw new RunnerError('タイムアウト', 'timeout')
    }
    return { raw: this.behavior.raw, elapsedMs: 1, commandLine: 'mock' }
  }
}
