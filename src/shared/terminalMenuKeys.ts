/**
 * Windows / Linux で、ターミナルにフォーカスがあるときにメニューのショートカットより先にターミナルへ渡すキー（Orca #11540）。
 *
 * メニューの accelerator（Ctrl+O・Ctrl+R・Ctrl+W・Ctrl+B、編集の Ctrl+C・Ctrl+V・Ctrl+A など）は、ページのキーより先に
 * Electron が取ってしまう。ターミナルではこれらがシェル・tmux・readline のキー（Ctrl+R の履歴検索、Ctrl+W の単語消去、
 * tmux の Ctrl+B、Ctrl+C の中断）なので、メニューに取らせない。Ctrl+Shift+C / V はターミナルのコピー・貼り付け（terminalKeys.ts）。
 * macOS のメニューは ⌘ なので、ターミナルのキー（Ctrl）とぶつからない
 */
export interface MenuKeyInput {
  type?: string
  key: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

export function terminalOwnsMenuKey(input: MenuKeyInput, platform: string): boolean {
  if (platform === 'darwin' || !input.control || input.alt || input.meta) return false
  if (!input.shift) return true
  const key = input.key.toLowerCase()
  return key === 'c' || key === 'v'
}
