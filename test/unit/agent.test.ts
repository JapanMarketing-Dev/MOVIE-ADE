/**
 * Agent への送信と状態検知。
 * 実際の claude / codex の出力を固定入力にしてある（test/unit/fixtures-agent.ts）。
 * CLI もネットワークも呼ばない。
 */
import { describe, expect, it } from 'vitest'
import {
  AgentStateTracker,
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  ComposerReadiness,
  buildPrompt,
  copyText,
  detectState,
  displayPriority,
  hasVisibleIdle,
  identifyAgent,
  normalizeTail,
  parseTitle,
  sanitizePastePayload,
  sendToAgent,
  splitForWrite,
  stripAnsi,
  stripSpinner,
  waitForComposer
} from '../../src/main/agent/index'
import type { AgentState, AgentTerminal } from '../../src/main/agent/index'
import {
  CLAUDE_STARTUP_HEAD,
  CLAUDE_TRUST_DIALOG,
  CODEX_STARTUP_HEAD,
  CODEX_UPDATE_MENU
} from './fixtures-agent'
import { setLocale } from '@shared/i18n'

// 日本語の文言を確かめるテストなので、画面の言語を日本語に固定する（既定は英語）
setLocale('ja')

/** 書き込みを記録する偽のPTY */
function fakeTerminal(): AgentTerminal & { writes: string[]; emit: (chunk: string) => void } {
  const listeners: Array<(c: string) => void> = []
  return {
    writes: [],
    write(data: string) {
      this.writes.push(data)
    },
    onData(listener) {
      listeners.push(listener)
      return () => {
        const i = listeners.indexOf(listener)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    emit(chunk: string) {
      for (const l of [...listeners]) l(chunk)
    }
  }
}

const noSleep = async (): Promise<void> => undefined

describe('本文の整え方（04_benchmark.md 3.3）', () => {
  it('改行を CR に正規化する（生の LF を TUI が送信と解釈しないように）', () => {
    expect(sanitizePastePayload('a\nb\r\nc')).toBe('a\rb\rc')
  })

  it('ESC を可視文字に置き換える（ペーストの枠を壊さない）', () => {
    expect(sanitizePastePayload('a\x1b[31mb')).toBe('a␛[31mb')
  })

  it('そのほかの制御文字を落とし、タブは残す', () => {
    expect(sanitizePastePayload('a\x00b\x07c\td')).toBe('abc\td')
  })

  it('マルチバイト文字の途中で割らない', () => {
    const chunks = splitForWrite('あいうえお', 7) // 1文字3バイト
    expect(chunks.join('')).toBe('あいうえお')
    for (const c of chunks) expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(7)
  })

  it('送信する指示文を組み立てる', () => {
    expect(buildPrompt('.ade-movie/reviews/20261002-104012')).toBe(
      '".ade-movie/reviews/20261002-104012/feedback.md" と、同じフォルダにある各指摘の画像を読み、送信対象の指摘をすべて実装してください。受け入れ条件は、すべての指摘が実装され、指摘ごとに完了したことを確かめたことです。確かめるときは、変更した画面や動作を実際に確認してください。テストやビルドが通るだけでは完了としません。最後に、指摘ごとに「完了／未完了（理由）」と確かめた方法を一覧で報告してください。未完了の指摘が残っている間は、完了と報告しないでください。 作業しながら、feedback.md の「進み具合」の節に従って ".ade-movie/reviews/20261002-104012/progress.json" に指摘ごとの進み具合を書いてください（着手したら in_progress、終えたら done）。 未完了の指摘は、使えるならサブエージェントで並列に進めてください。前提が合わない指摘（録画が古いなど）は直さず、理由を note に書いて needs_human にしてください。'
    )
    // 末尾のスラッシュは吸収する
    expect(buildPrompt('.ade-movie/reviews/x/')).toContain('.ade-movie/reviews/x/feedback.md')
    // 設定で変えられる
    expect(buildPrompt('d', '{{path}} を見て')).toBe('d/feedback.md を見て')
    expect(copyText('abc')).toBe('abc')
  })
})

describe('送信の手順', () => {
  it('本文と Enter を別の write で送り、間に待ち時間を入れる', async () => {
    const term = fakeTerminal()
    const waited: number[] = []
    const result = await sendToAgent({
      terminal: term,
      text: 'feedback.md を読んで',
      getState: () => 'idle',
      sleep: async (ms) => {
        waited.push(ms)
      }
    })

    expect(result.ok).toBe(true)
    expect(term.writes).toHaveLength(2)
    expect(term.writes[0]).toBe(`${BRACKETED_PASTE_START}feedback.md を読んで${BRACKETED_PASTE_END}`)
    expect(term.writes[1]).toBe('\r')
    expect(waited).toEqual([50])
  })

  it('権限の確認待ちでは送らず、理由を返す', async () => {
    const term = fakeTerminal()
    const result = await sendToAgent({ terminal: term, text: 'x', getState: () => 'blocked', sleep: noSleep })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toBe('permission')
    expect(result.bodyWritten).toBe(false)
    expect(term.writes).toHaveLength(0)
    expect(result.message).toContain('確認を待っています')
  })

  it('処理中（working）は送る。Agent 側で順番待ちになる', async () => {
    const term = fakeTerminal()
    const result = await sendToAgent({ terminal: term, text: 'x', getState: () => 'working', sleep: noSleep })
    expect(result.ok).toBe(true)
    expect(term.writes).toHaveLength(2)
  })

  it('状態が分からないときは送らない', async () => {
    const term = fakeTerminal()
    const result = await sendToAgent({ terminal: term, text: 'x', getState: () => 'unknown', sleep: noSleep })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toBe('not-ready')
  })

  it('本文のあとで権限待ちに変わったら Enter を送らない（本文だけ残ったことを伝える）', async () => {
    const term = fakeTerminal()
    const states: AgentState[] = ['idle', 'blocked']
    let i = 0
    const result = await sendToAgent({
      terminal: term,
      text: 'x',
      getState: () => states[i++] ?? 'idle',
      sleep: noSleep
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toBe('permission')
    expect(result.bodyWritten).toBe(true)
    // 本文は入っているが Enter は送っていない
    expect(term.writes).toHaveLength(1)
    expect(term.writes[0]).not.toContain('\r')
  })

  it('空の本文は送らない', async () => {
    const term = fakeTerminal()
    const result = await sendToAgent({ terminal: term, text: '   \n ', getState: () => 'idle', sleep: noSleep })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toBe('empty')
    expect(term.writes).toHaveLength(0)
  })

  it('64KiB を超える本文は分けて送り、終了マーカーを必ず流す', async () => {
    const term = fakeTerminal()
    const big = 'あ'.repeat(30_000) // 90KB
    const result = await sendToAgent({ terminal: term, text: big, getState: () => 'idle', sleep: noSleep })

    expect(result.ok).toBe(true)
    expect(term.writes[0]).toBe(BRACKETED_PASTE_START)
    expect(term.writes[term.writes.length - 1]).toBe('\r')
    expect(term.writes[term.writes.length - 2]).toBe(BRACKETED_PASTE_END)
    // 本文は開始と終了の間に入っている
    expect(term.writes.slice(1, -2).join('')).toBe(big)
  })

  it('途中の書き込みが失敗しても終了マーカーを流して枠を閉じる', async () => {
    const writes: string[] = []
    let n = 0
    const term: AgentTerminal = {
      write(data) {
        writes.push(data)
        n += 1
        if (n === 3) throw new Error('PTYが閉じた')
      },
      onData: () => () => undefined
    }
    const result = await sendToAgent({
      terminal: term,
      text: 'あ'.repeat(30_000),
      getState: () => 'idle',
      sleep: noSleep
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toBe('write-failed')
    expect(writes[writes.length - 1]).toBe(BRACKETED_PASTE_END)
  })

  it('書き込みが失敗したら理由を返す', async () => {
    const term: AgentTerminal = {
      write() {
        throw new Error('EPIPE')
      },
      onData: () => () => undefined
    }
    const result = await sendToAgent({ terminal: term, text: 'x', getState: () => 'idle', sleep: noSleep })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure).toBe('write-failed')
      expect(result.message).toContain('EPIPE')
    }
  })
})

describe('実際の出力からの状態判定', () => {
  it('claude の起動直後は、カーソル移動を空白に戻してから判定する', () => {
    const tail = normalizeTail(stripAnsi(CLAUDE_TRUST_DIALOG))
    // 単語が繋がっていないこと（これを間違えると文字列判定が全部外れる）
    expect(tail).toContain('Yes, I trust this folder')
    expect(tail).toContain('Enter to confirm')
    expect(detectState('claude-code', { tail })).toBe('blocked')
  })

  it('codex の更新メニューも権限待ちとして扱う（Enter を取られる）', () => {
    const tail = normalizeTail(stripAnsi(CODEX_UPDATE_MENU))
    expect(tail).toContain('Press enter to continue')
    expect(detectState('codex', { tail })).toBe('blocked')
  })

  it('起動直後の出力に準備完了のしるしが含まれる', () => {
    for (const head of [CLAUDE_STARTUP_HEAD, CODEX_STARTUP_HEAD]) {
      const readiness = new ComposerReadiness({ now: () => 0 })
      readiness.push(head)
      expect(readiness.signalled).toBe(true)
    }
  })

  it('OSC のタイトルを取り出す（最後のものを使う）', () => {
    expect(parseTitle('\x1b]2;✳ 考えています\x07x\x1b]2;✳ 完了\x07')).toBe('✳ 完了')
    expect(parseTitle('なにもない')).toBeUndefined()
  })

  it('タイトルのスピナーを剥がす', () => {
    expect(stripSpinner('⠋ 考えています')).toBe('考えています')
    expect(stripSpinner('✳ 待機中')).toBe('待機中')
    expect(stripSpinner('ふつうのタイトル')).toBe('ふつうのタイトル')
  })

  it('タイトルがスピナー始まりなら working', () => {
    expect(detectState('claude-code', { title: '⠙ Thinking…' })).toBe('working')
    expect(detectState('claude-code', { title: '◐ 処理中' })).toBe('working')
  })

  it('codex のタイトルの Action Required は blocked', () => {
    expect(detectState('codex', { title: 'Action Required' })).toBe('blocked')
  })

  it('gitのworking tree警告が残っていても、完了後の入力欄を待機と判定する', () => {
    const tail = 'warning: Not a git repository. Use --no-index to compare two paths outside a working tree\n対応しました。\n› Ask Codex to do anything'
    expect(detectState('codex', { title: '⠹ 古い処理タイトル', tail })).toBe('idle')
    expect(detectState('codex', { tail: '• Working (2s • esc to interrupt)\n› Ask Codex to do anything' })).toBe('working')
  })

  it('タイトルがあってスピナーでなければ idle', () => {
    expect(detectState('claude-code', { title: '✳ ade-movie' })).toBe('idle')
  })

  it('タイトルが無ければ画面末尾の入力欄を見る', () => {
    expect(detectState('claude-code', { tail: 'なにか\n❯ \n' })).toBe('idle')
    expect(detectState('codex', { tail: 'なにか\n› \n' })).toBe('idle')
    expect(hasVisibleIdle('なにか\n❯ \n')).toBe(true)
    expect(detectState('claude-code', { tail: 'よく分からない出力' })).toBe('unknown')
  })

  it('権限待ちはタイトルより優先する（タイトルが古いことがある）', () => {
    const tail = normalizeTail(stripAnsi(CLAUDE_TRUST_DIALOG))
    expect(detectState('claude-code', { title: '✳ ade-movie', tail })).toBe('blocked')
  })

  it('どの Agent かはコマンド名で同定する（状態判定には使わない）', () => {
    expect(identifyAgent('claude')).toBe('claude-code')
    expect(identifyAgent('/Users/me/bin/claude --resume')).toBe('claude-code')
    expect(identifyAgent('codex')).toBe('codex')
    expect(identifyAgent('zsh')).toBe('unknown')
  })
})

describe('入力欄の準備完了待ち', () => {
  it('しるしを見て、出力が静止したら送れる', () => {
    let t = 0
    const r = new ComposerReadiness({ now: () => t })
    expect(r.status()).toBe('starting')
    r.push('\x1b[?2004h')
    expect(r.status()).toBe('settling')
    t = 1600
    expect(r.status()).toBe('ready')
  })

  it('出力が動いている間は待つ', () => {
    let t = 0
    const r = new ComposerReadiness({ now: () => t })
    r.push('\x1b[?2004h')
    t = 1400
    r.push('まだ描画中')
    t = 2000
    expect(r.status()).toBe('settling')
    t = 3000
    expect(r.status()).toBe('ready')
  })

  it('しるしが出ないまま上限に達したら timeout', () => {
    let t = 0
    const r = new ComposerReadiness({ now: () => t })
    t = 8000
    expect(r.status()).toBe('timeout')
  })

  it('待ってから結果を返す（上限で打ち切る）', async () => {
    let t = 0
    const r = new ComposerReadiness({ now: () => t })
    const status = await waitForComposer(r, {
      sleep: async () => {
        t += 1000
      },
      pollMs: 100
    })
    expect(status).toBe('timeout')
  })
})

describe('状態の保持と「終わったがまだ見ていない」', () => {
  const tracker = (now: () => number) =>
    new AgentStateTracker({ now, startupQuietMs: 0, settleChecks: 1, settleMs: 0 })

  it('見ていないタブで working → idle になったら done', () => {
    let t = 1000
    const tr = tracker(() => t)
    expect(tr.observe('working', { visible: false })).toBe(true)
    t += 100
    expect(tr.observe('idle', { visible: false })).toBe(true)
    expect(tr.current()).toBe('idle')
    expect(tr.display()).toBe('done')
  })

  it('見ているタブなら done にせず idle のまま', () => {
    let t = 1000
    const tr = tracker(() => t)
    tr.observe('working', { visible: true })
    t += 100
    tr.observe('idle', { visible: true })
    expect(tr.display()).toBe('idle')
  })

  it('タブを見たら done は idle へ戻る（戻る唯一の条件）', () => {
    let t = 1000
    const tr = tracker(() => t)
    tr.observe('working', { visible: false })
    t += 100
    tr.observe('idle', { visible: false })
    expect(tr.display()).toBe('done')
    tr.markSeen()
    expect(tr.display()).toBe('idle')
  })

  it('起動直後は状態を出さない', () => {
    let t = 0
    const tr = new AgentStateTracker({ now: () => t, startupQuietMs: 3000 })
    expect(tr.observe('working', { visible: true })).toBe(false)
    t = 3001
    expect(tr.observe('working', { visible: true })).toBe(true)
  })

  it('working → idle は確定を遅らせる（表示の点滅を防ぐ）', () => {
    let t = 5000
    const tr = new AgentStateTracker({ now: () => t, startupQuietMs: 0, settleChecks: 3, settleMs: 700 })
    tr.observe('working', { visible: true })
    // 1回目・2回目は確定しない
    expect(tr.observe('idle', { visible: true })).toBe(false)
    expect(tr.observe('idle', { visible: true })).toBe(false)
    expect(tr.current()).toBe('working')
    // 3回目で確定
    expect(tr.observe('idle', { visible: true })).toBe(true)
    expect(tr.current()).toBe('idle')
  })

  it('待機中のしるしが画面に見えていれば即確定する', () => {
    const t = 5000
    const tr = new AgentStateTracker({ now: () => t, startupQuietMs: 0, settleChecks: 3, settleMs: 700 })
    tr.observe('working', { visible: true })
    expect(tr.observe('idle', { visible: true, visibleIdle: true })).toBe(true)
    expect(tr.current()).toBe('idle')
  })

  it('時間が経てば回数が足りなくても確定する', () => {
    let t = 5000
    const tr = new AgentStateTracker({ now: () => t, startupQuietMs: 0, settleChecks: 99, settleMs: 700 })
    tr.observe('working', { visible: true })
    expect(tr.observe('idle', { visible: true })).toBe(false)
    t += 800
    expect(tr.observe('idle', { visible: true })).toBe(true)
  })

  it('プロセス終了は保留を飛ばして必ず idle', () => {
    let t = 5000
    const tr = tracker(() => t)
    tr.observe('working', { visible: false })
    t += 10
    tr.markExited({ visible: false })
    expect(tr.current()).toBe('idle')
    expect(tr.display()).toBe('done')
    // 終了後は状態を動かさない
    expect(tr.observe('working', { visible: false })).toBe(false)
  })

  it('blocked のときは送信できない', () => {
    let t = 5000
    const tr = tracker(() => t)
    tr.observe('blocked', { visible: true })
    expect(tr.canSend()).toBe(false)
    t += 10
    tr.observe('idle', { visible: true })
    expect(tr.canSend()).toBe(true)
  })

  it('表示の並び順は blocked > done > working > idle > unknown', () => {
    expect(displayPriority.blocked).toBeGreaterThan(displayPriority.done)
    expect(displayPriority.done).toBeGreaterThan(displayPriority.working)
    expect(displayPriority.working).toBeGreaterThan(displayPriority.idle)
    expect(displayPriority.idle).toBeGreaterThan(displayPriority.unknown)
  })
})
