import { describe, expect, it } from 'vitest'
import { nextLaunchAgentPhase, type LaunchAgentPhase } from '../../src/main/agent/launchPhase'

function run(foregrounds: boolean[]): LaunchAgentPhase {
  return foregrounds.reduce<LaunchAgentPhase>((phase, fg) => nextLaunchAgentPhase(phase, fg), undefined)
}

describe('起動時の Agent の推定（Orca #6355）', () => {
  it('起動前のシェルだけの間は推定を続ける（Agent の起動を待つ）', () => {
    expect(run([false, false])).toBeUndefined()
  })

  it('Agent が動いている間は seen', () => {
    expect(run([false, true, true])).toBe('seen')
  })

  it('Agent が終わってシェルに戻ったら ended。以後に別のプログラムが動いても戻らない', () => {
    expect(run([true, false])).toBe('ended')
    expect(run([true, false, true, true])).toBe('ended')
  })
})
