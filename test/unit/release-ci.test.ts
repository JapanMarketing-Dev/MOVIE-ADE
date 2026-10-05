import { describe, expect, it } from 'vitest'
import { ciVerdict } from '../../scripts/release-ci.mjs'

const run = (over: Record<string, unknown>) => ({ name: 'Cross-platform', head_sha: 'abc', status: 'completed', conclusion: 'success', created_at: '2026-10-05T03:00:00Z', ...over })

describe('公開する commit の GitHub Actions（release-ci.mjs）', () => {
  it('Cross-platform が通っていれば success', () => {
    expect(ciVerdict([run({})], 'abc')).toEqual({ state: 'success' })
  })
  it('落ちていれば failure（0.4.10 は GitHub の Linux でだけ落ちたまま公開した）', () => {
    expect(ciVerdict([run({ conclusion: 'failure', html_url: 'https://x' })], 'abc').state).toBe('failure')
  })
  it('まだ動いている・無いときは pending。別の commit の結果は見ない', () => {
    expect(ciVerdict([run({ status: 'in_progress', conclusion: null })], 'abc').state).toBe('pending')
    expect(ciVerdict([run({ head_sha: 'other' })], 'abc').state).toBe('pending')
  })
  it('同じワークフローが複数あれば一番新しいもので決める', () => {
    const runs = [run({ conclusion: 'failure', created_at: '2026-10-05T03:00:00Z' }), run({ conclusion: 'success', created_at: '2026-10-05T04:00:00Z' })]
    expect(ciVerdict(runs, 'abc').state).toBe('success')
  })
})
