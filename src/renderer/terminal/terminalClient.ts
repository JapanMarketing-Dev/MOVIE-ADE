import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalSize } from '@shared/types'
import { THEME_CHANGE_EVENT } from '../lib/theme'
import { t } from '@shared/i18n'
import { reportAnomaly, reportHandled } from '@shared/report'

/**
 * renderer 側のターミナル実体（xterm.js）を管理する。
 *
 * React の外に置く: xterm はDOMを自分で持ち、再レンダリングで作り直されると
 * 画面と履歴が消えるため、インスタンスの寿命はReactのツリーと切り離す。
 *
 * 描画は WebGL を第一候補にし、使えなければ Canvas → DOM へ落とす（設計 1.3）。
 */

type RendererKind = 'webgl' | 'canvas' | 'dom'

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

function theme() {
  return {
    foreground: cssVar('--term-fg', '#d7dce3'),
    background: cssVar('--term-bg', '#0b0d11'),
    cursor: cssVar('--term-cursor', '#4c8dff'),
    selectionBackground: cssVar('--term-selection', '#2b3a52'),
    black: cssVar('--term-black', '#2b303b'),
    red: cssVar('--term-red', '#ff6b63'),
    green: cssVar('--term-green', '#4ec98b'),
    yellow: cssVar('--term-yellow', '#e3b341'),
    blue: cssVar('--term-blue', '#5a9cff'),
    magenta: cssVar('--term-magenta', '#c58cff'),
    cyan: cssVar('--term-cyan', '#4fd0d6'),
    white: cssVar('--term-white', '#c6ccd6'),
    brightBlack: cssVar('--term-bright-black', '#5b6472'),
    brightRed: cssVar('--term-bright-red', '#ff8d86'),
    brightGreen: cssVar('--term-bright-green', '#74dda6'),
    brightYellow: cssVar('--term-bright-yellow', '#f0cc6b'),
    brightBlue: cssVar('--term-bright-blue', '#85b7ff'),
    brightMagenta: cssVar('--term-bright-magenta', '#d6abff'),
    brightCyan: cssVar('--term-bright-cyan', '#7fe0e4'),
    brightWhite: cssVar('--term-bright-white', '#f0f3f7')
  }
}

export class TerminalHandle {
  readonly term: Terminal
  private readonly fitAddon = new FitAddon()
  private disposers: Array<() => void> = []
  private pending: string[] = []
  private opened = false
  /**
   * xterm を開く器。React の描画先とは別に持ち、分割で木の形が変わってペインのDOMが
   * 作り直されても、この器を新しい場所へ移すだけで画面と履歴を保つ
   */
  private readonly host: HTMLDivElement
  private screenTimer: ReturnType<typeof setTimeout> | null = null
  private fitFrame = 0

  ptyId: string | null = null
  renderer: RendererKind = 'dom'

  constructor(readonly key: string) {
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: cssVar('--font-mono', 'monospace'),
      fontSize: Number.parseInt(cssVar('--term-font-size', '12px'), 10) || 12,
      lineHeight: Number.parseFloat(cssVar('--term-line-height', '1.2')) || 1.2,
      scrollback: 10000,
      // 大量出力時のちらつきを抑える（PTY側でまとめているので描画も1回で足りる）
      smoothScrollDuration: 0,
      theme: theme()
    })
    this.term.loadAddon(this.fitAddon)
    this.host = document.createElement('div')
    this.host.className = 'terminal-host'
    // ライト／ダークの切り替えに追従する（tokens.css の --term-* を読み直す）
    const onTheme = () => {
      this.term.options.theme = theme()
    }
    window.addEventListener(THEME_CHANGE_EVENT, onTheme)
    this.disposers.push(() => window.removeEventListener(THEME_CHANGE_EVENT, onTheme))
    // 入力は開く前から受けられるようにしておく（PTYができる前の打鍵は pending にためる）
    const onData = this.term.onData((data) => {
      if (this.ptyId) void window.ade.invoke('terminal:write', this.ptyId, data)
      else this.pending.push(data)
    })
    this.disposers.push(() => onData.dispose())
    // 器の大きさが変わるたびに（分割・ドラッグ・ウィンドウ・ターミナルの配置の変更・表示の切り替え）、
    // まだ開いていなければ開き、開いていれば寸法を合わせ直す
    const observer = new ResizeObserver(() => {
      this.tryOpen()
      this.scheduleFit()
    })
    observer.observe(this.host)
    this.disposers.push(() => observer.disconnect())
  }

  /**
   * node の中に表示する。別の node へ移されたら器ごと移す（xterm は作り直さない）。
   *
   * xterm を実際に開く（term.open）のは、器に大きさが付いてから。非表示のタブや、閉じた（0px の）ターミナルの
   * 中で開くと、xterm が文字の寸法を 0 と測ったままになり、表示しても真っ黒のまま描かれない。
   * 開く前に届いた出力は xterm のバッファに入っているので、開いた時点でそのまま描かれる
   */
  open(node: HTMLElement): void {
    if (this.host.parentElement !== node) node.appendChild(this.host)
    this.tryOpen()
  }

  private tryOpen(): void {
    if (this.opened || this.host.clientWidth === 0 || this.host.clientHeight === 0) return
    this.term.open(this.host)
    this.opened = true
    // 描画の切り替えやフォントの読み込みで文字の寸法が変わったときも合わせ直す
    void this.loadRenderer().then(() => this.scheduleFit())
    void document.fonts?.ready.then(() => this.scheduleFit())
    this.scheduleFit()
  }

  /** WebGL → Canvas → DOM の順に試す。読み込みは遅延させて起動を軽くする */
  private async loadRenderer(): Promise<void> {
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl')
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        // GPU のリセットなどで WebGL の描画が失われた。Canvas へ切り替えて続ける
        reportAnomaly('xterm webgl context lost', { kind: 'render', area: 'terminal' })
        addon.dispose()
        void this.loadCanvas()
      })
      this.term.loadAddon(addon)
      this.renderer = 'webgl'
      return
    } catch (err) {
      console.warn('[terminal] WebGL描画を使えません。Canvasへ切り替えます', err)
      reportHandled(err, { area: 'terminal', op: 'load webgl renderer' })
    }
    await this.loadCanvas()
  }

  private async loadCanvas(): Promise<void> {
    try {
      const { CanvasAddon } = await import('@xterm/addon-canvas')
      this.term.loadAddon(new CanvasAddon())
      this.renderer = 'canvas'
    } catch (err) {
      console.warn('[terminal] Canvas描画も使えません。DOM描画で続けます', err)
      reportHandled(err, { area: 'terminal', op: 'load canvas renderer' })
      this.renderer = 'dom'
    }
  }

  /** 次のフレームで寸法を合わせ、変わっていればPTYにも伝える（非表示のあいだは何もしない） */
  scheduleFit(): void {
    cancelAnimationFrame(this.fitFrame)
    this.fitFrame = requestAnimationFrame(() => {
      if (!this.opened || this.host.clientWidth === 0 || this.host.clientHeight === 0) return
      const before = this.size()
      const size = this.fit()
      if (!size || !this.ptyId) return
      if (size.cols !== before.cols || size.rows !== before.rows || !this.ptySized || this.redrawPending) {
        this.ptySized = true
        if (this.redrawPending && size.rows > 1) {
          // 大きさを一度だけ揺らして、全画面の TUI（Claude Code / Codex など）に描き直してもらう
          void window.ade.invoke('terminal:resize', this.ptyId, { cols: size.cols, rows: size.rows - 1 })
        }
        this.redrawPending = false
        void window.ade.invoke('terminal:resize', this.ptyId, size)
      }
    })
  }

  /** PTYへ今の寸法を一度でも伝えたか。80x24 の仮の大きさで作ったPTYを、表示時に必ず合わせ直す */
  private ptySized = false
  /** 次に寸法を伝えるとき、大きさを一度揺らして描き直してもらう（読み込み直しのあと、つなぎ直したとき） */
  private redrawPending = false

  /**
   * 画面を読み込み直したあと、生きている PTY につなぎ直す。直近の出力を流し直し、
   * 表示したときに TUI へ描き直しを頼む（流し直した出力は途中から始まることがあるため）
   */
  reattach(ptyId: string, history: string, size?: TerminalSize): void {
    // 出力は PTY の今の幅で折り返されているので、同じ大きさにしてから流し直す（違う幅だと崩れる）
    if (size && size.cols >= 2 && size.rows >= 1) this.term.resize(size.cols, size.rows)
    if (history) this.term.write(history)
    this.bindPty(ptyId)
    this.redrawPending = true
    this.scheduleFit()
  }

  bindPty(ptyId: string): void {
    this.ptyId = ptyId
    this.ptySized = false
    this.scheduleFit()
    if (this.pending.length > 0) {
      const data = this.pending.join('')
      this.pending = []
      void window.ade.invoke('terminal:write', ptyId, data)
    }
  }

  write(data: string): void {
    this.term.write(data, () => {
      if (this.screenTimer || !this.ptyId) return
      this.screenTimer = setTimeout(() => {
        this.screenTimer = null
        if (!this.ptyId) return
        const buffer = this.term.buffer.active
        const lines: string[] = []
        for (let i = buffer.baseY; i < buffer.baseY + this.term.rows; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
        void window.ade.invoke('terminal:screen', this.ptyId, lines.join('\n'))
      }, 200)
    })
  }

  size(): TerminalSize {
    return { cols: this.term.cols, rows: this.term.rows }
  }

  /** 表示中のタブだけ呼ぶ（非表示のタブは寸法が0になり、fitが誤った値を返す） */
  fit(): TerminalSize | null {
    try {
      this.fitAddon.fit()
    } catch {
      // 寸法が決まる前（非表示・破棄中）は測れない（想定内。次の fit で測り直す）
      return null
    }
    const size = this.size()
    if (size.cols < 2 || size.rows < 1) return null
    return size
  }

  focus(): void {
    this.term.focus()
  }

  /**
   * 画面に出ている文字列。E2Eが出力を確認するために使う。
   * WebGL / Canvas 描画ではDOMに文字が残らないため、xtermのバッファから取り出す。
   */
  readText(): string {
    const buffer = this.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    }
    return lines.join('\n').replace(/\n+$/, '')
  }

  dispose(): void {
    if (this.screenTimer) clearTimeout(this.screenTimer)
    cancelAnimationFrame(this.fitFrame)
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.host.remove()
    try {
      this.term.dispose()
    } catch (err) {
      // 描画アドオンの破棄でまれに例外が出ても、タブは閉じられるようにする
      console.warn('[terminal] 破棄中にエラーが出ました', err)
      reportHandled(err, { area: 'terminal', op: 'dispose xterm' })
    }
  }
}

const handles = new Map<string, TerminalHandle>()
let subscribed = false

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  window.ade.on('terminal:data', (ptyId, data) => {
    for (const handle of handles.values()) {
      if (handle.ptyId === ptyId) {
        handle.write(data)
        return
      }
    }
  })
  window.ade.on('terminal:exit', (ptyId, exitCode) => {
    for (const handle of handles.values()) {
      if (handle.ptyId === ptyId) {
        handle.write(`\r\n\u001b[2m${t('terminal.processExited', { code: exitCode })}\u001b[0m\r\n`)
        handle.ptyId = null
        return
      }
    }
  })
}

export function acquireTerminal(key: string): TerminalHandle {
  subscribe()
  let handle = handles.get(key)
  if (!handle) {
    handle = new TerminalHandle(key)
    handles.set(key, handle)
  }
  return handle
}

export function releaseTerminal(key: string): void {
  const handle = handles.get(key)
  if (!handle) return
  handles.delete(key)
  if (handle.ptyId) void window.ade.invoke('terminal:close', handle.ptyId)
  handle.dispose()
}

export function getTerminal(key: string): TerminalHandle | undefined {
  return handles.get(key)
}
