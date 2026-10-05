import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TERMINAL_MOUNT_CLASS, readFeedbackSideTab, shownFeedbackSideTab, terminalPlacement } from '../../src/renderer/lib/feedbackSide'

describe('フィードバックの右パネルのターミナル（エディタと同じターミナルを移して見せる）', () => {
  it('覚えたタブを読む。知らない値・空はレビュー対象', () => {
    expect(readFeedbackSideTab('terminal')).toBe('terminal')
    expect(readFeedbackSideTab('transcript')).toBe('transcript')
    expect(readFeedbackSideTab('targets')).toBe('targets')
    expect(readFeedbackSideTab(null)).toBe('targets')
    expect(readFeedbackSideTab('shell')).toBe('targets')
  })

  it('文字起こしを出さない設定では、文字起こしの代わりにレビュー対象。ターミナルはそのまま', () => {
    expect(shownFeedbackSideTab('transcript', false)).toBe('targets')
    expect(shownFeedbackSideTab('transcript', true)).toBe('transcript')
    expect(shownFeedbackSideTab('terminal', false)).toBe('terminal')
    expect(shownFeedbackSideTab('targets', true)).toBe('targets')
  })

  it('フィードバックモードで右パネルを開いてターミナルのタブを見ているときだけ右パネルへ移す', () => {
    expect(terminalPlacement({ mode: 'feedback', targetsOpen: true, shownTab: 'terminal' })).toBe('feedback')
    expect(terminalPlacement({ mode: 'feedback', targetsOpen: false, shownTab: 'terminal' })).toBe('editor')
    expect(terminalPlacement({ mode: 'feedback', targetsOpen: true, shownTab: 'transcript' })).toBe('editor')
    expect(terminalPlacement({ mode: 'feedback', targetsOpen: true, shownTab: 'targets' })).toBe('editor')
    // エディタへ戻ったら、右パネルで何を選んでいてもエディタの場所へ
    expect(terminalPlacement({ mode: 'editor', targetsOpen: true, shownTab: 'terminal' })).toBe('editor')
  })

  it('移す器の class は xterm の器（.terminal-host・絶対配置）と別。同じだと器が窓いっぱいに広がり、録画のボタンを覆った', () => {
    const css = (name: string) => readFileSync(resolve(__dirname, '../../src/renderer/styles', name), 'utf8')
    const client = readFileSync(resolve(__dirname, '../../src/renderer/terminal/terminalClient.ts'), 'utf8')
    expect(client).toContain("className = 'terminal-host'")
    expect(TERMINAL_MOUNT_CLASS).not.toBe('terminal-host')
    // xterm の器を絶対配置にする決まり（shell.css）は、移す器には当たらない
    expect(css('shell.css')).not.toContain(`.${TERMINAL_MOUNT_CLASS}`)
    // 移す器を広げる決まり（app.css）は、xterm の器には当てない
    expect(css('app.css')).toContain(`.${TERMINAL_MOUNT_CLASS} {`)
    expect(css('app.css')).not.toMatch(/\.terminal-host\b/)
  })
})
