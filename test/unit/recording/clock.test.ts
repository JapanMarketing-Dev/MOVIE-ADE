import { describe, expect, it } from 'vitest'
import { RecordingClock } from '../../../src/main/recording/clock'

/**
 * 録画の時計（設計4章）。動画・静止画・音声・操作ログがこの1つの時計を見る。
 * 一時停止した分を進めないことと、他プロセスの時刻を同じ軸へ直せることを守る。
 */
describe('RecordingClock', () => {
  it('開始からの経過を返す', () => {
    const clock = new RecordingClock(1000)
    expect(clock.now(1000)).toBe(0)
    expect(clock.now(1500)).toBe(500)
  })

  it('一時停止している間は進まない', () => {
    const clock = new RecordingClock(1000)
    clock.pause(1500)
    expect(clock.now(1500)).toBe(500)
    expect(clock.now(9000)).toBe(500)
    expect(clock.paused).toBe(true)
  })

  it('再開すると、止めていた分を飛ばして続きから進む', () => {
    const clock = new RecordingClock(1000)
    clock.pause(1500) // 500ms 録った
    clock.resume(4000) // 2.5秒 止めていた
    expect(clock.paused).toBe(false)
    expect(clock.now(4200)).toBe(700)
  })

  it('一時停止と再開を繰り返しても累積する', () => {
    const clock = new RecordingClock(0)
    clock.pause(1000)
    clock.resume(2000)
    clock.pause(2500)
    clock.resume(5000)
    expect(clock.now(5100)).toBe(1600)
  })

  it('二重の pause / resume は効かない', () => {
    const clock = new RecordingClock(0)
    clock.pause(1000)
    clock.pause(3000)
    clock.resume(4000)
    clock.resume(6000)
    expect(clock.now(4500)).toBe(1500)
  })

  it('他プロセスの epoch を同じ時計へ直せる', () => {
    // 注入スクリプトも録画用ウィンドウも Date.now() で時刻を付けてくる
    const clock = new RecordingClock(10_000)
    expect(clock.fromEpoch(10_250)).toBe(250)

    clock.pause(11_000) // 1秒ぶん録った
    expect(clock.fromEpoch(99_999)).toBe(1000) // 停止中はどの時刻も「止めた時点」

    clock.resume(20_000)
    expect(clock.fromEpoch(20_500)).toBe(1500)
  })
})
