import { getTerminal } from './terminal/terminalClient'

/**
 * E2E（Playwright）から画面の内側を確認するための窓口。
 *
 * ターミナルは WebGL / Canvas で描画するため、画面の文字がDOMに残らない。
 * Playwright からテキストを読めるように、xterm のバッファを取り出す関数だけを公開する。
 * 読み取り専用で、アプリの動作は変えない。
 */
interface AdeTestHooks {
  terminalText(tabKey?: string): string
  terminalRenderer(tabKey?: string): string
  terminalTabKeys(): string[]
}

declare global {
  interface Window {
    __adeTest?: AdeTestHooks
  }
}

/** 選択中のタブで、フォーカスしているペインのキー（xterm はペインごとに持つ） */
function activeTabKey(): string | null {
  const tab = document.querySelector<HTMLElement>('.terminal-tab[aria-selected="true"]')
  if (tab?.dataset.activePane) return tab.dataset.activePane
  const id = tab?.dataset.testid
  return id ? id.replace(/^terminal-tab-/, '') : null
}

export function installTestHooks(): () => void {
  window.__adeTest = {
    terminalText(tabKey) {
      const key = tabKey ?? activeTabKey()
      return key ? (getTerminal(key)?.readText() ?? '') : ''
    },
    terminalRenderer(tabKey) {
      const key = tabKey ?? activeTabKey()
      return key ? (getTerminal(key)?.renderer ?? 'none') : 'none'
    },
    terminalTabKeys() {
      return [...document.querySelectorAll<HTMLElement>('.terminal-tab')].map((el) =>
        (el.dataset.testid ?? '').replace(/^terminal-tab-/, '')
      )
    }
  }
  return () => {
    delete window.__adeTest
  }
}
