/**
 * 「内蔵ターミナルの新しいタブでこのコマンドを走らせて」という依頼の窓口。
 *
 * 設定の GitHub 節（`gh auth login --web` など）から使う。依頼を受けてタブを開くのは TerminalPane。
 * accountLogin.ts と同じく、App の別々の枝にある部品を window のイベントでつなぐ。
 * 購読する側がいない（ターミナルを開いていない）ときは false を返すので、呼び出し側はコマンドの写しを案内する。
 */

interface TerminalCommandRequest {
  /** シェルに打ち込む1行（改行は付けない。受け取った側が Enter を送る） */
  command: string
  /** タブの名前。省略時はシェルの名前 */
  title?: string
  /** 作業フォルダ（絶対パス）。省略時はプロジェクトのフォルダ */
  cwd?: string
}

const COMMAND_EVENT = 'ade:terminal-command'

/** 依頼を出す。受け取る側がいれば true */
export function requestTerminalCommand(req: TerminalCommandRequest): boolean {
  // 購読している側（onTerminalCommandRequest）が preventDefault() して「引き受けた」と返す
  const event = new CustomEvent<TerminalCommandRequest>(COMMAND_EVENT, { detail: req, cancelable: true })
  return !window.dispatchEvent(event)
}

/** 作業フォルダを cwd にした素のシェルのタブを開く（ファイルツリーの「ターミナルで開く」）。受け取る側がいれば true */
export function requestTerminalAt(cwd: string): boolean {
  return requestTerminalCommand({ command: '', cwd })
}

/** タブを開く側（TerminalPane）が購読する。購読していれば引き受けたことになる。戻り値で購読をやめる */
export function onTerminalCommandRequest(listener: (req: TerminalCommandRequest) => void): () => void {
  const wrapped = (event: Event) => {
    event.preventDefault()
    listener((event as CustomEvent<TerminalCommandRequest>).detail)
  }
  window.addEventListener(COMMAND_EVENT, wrapped)
  return () => window.removeEventListener(COMMAND_EVENT, wrapped)
}
