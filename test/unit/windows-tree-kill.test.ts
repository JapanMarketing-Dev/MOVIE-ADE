import { describe, expect, it } from 'vitest'
import { windowsTreeKillCommand } from '../../src/main/platform/windowsTreeKill'

describe('Windows でタブを閉じるときの taskkill（Orca #9704 #10150）', () => {
  it('System32 の taskkill を絶対パスで、子孫ごと（/T）強制で（/F）', () => {
    expect(windowsTreeKillCommand(4321, 'D:\\Win')).toEqual({ file: 'D:\\Win\\System32\\taskkill.exe', args: ['/PID', '4321', '/T', '/F'] })
  })

  it('SystemRoot が無い・相対なら C:\\Windows を使う（今のフォルダから探さない）', () => {
    expect(windowsTreeKillCommand(4321, undefined)?.file).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(windowsTreeKillCommand(4321, 'Windows')?.file).toBe('C:\\Windows\\System32\\taskkill.exe')
  })

  it('0・System（4）・負の値・小数の PID は触らない', () => {
    for (const pid of [0, 4, -1, 12.5, Number.NaN]) expect(windowsTreeKillCommand(pid, 'C:\\Windows')).toBeNull()
  })
})
