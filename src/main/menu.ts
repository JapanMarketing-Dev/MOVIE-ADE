import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/types'
import { PRODUCT_NAME, onLocaleChange, t } from '@shared/i18n'

/**
 * アプリケーションメニュー。
 * キーボードショートカットは `CmdOrCtrl` で宣言し、OSごとの修飾キー分岐を書かない
 * （macOS は ⌘、Windows / Linux は Ctrl に Electron が割り当てる）。
 * macOS ではアプリメニューが無いとコピー・ペーストのショートカットが効かないため、
 * 編集メニューは標準ロールで用意する。
 */
export function installMenu(handlers: {
  onOpenFolder: () => void
  onCommand: (command: MenuCommand) => void
}): void {
  buildMenu(handlers)
  // 画面の言語を切り替えたら、メニューを作り直す
  if (!unsubscribeLocale) unsubscribeLocale = onLocaleChange(() => buildMenu(handlers))
}

let unsubscribeLocale: (() => void) | null = null

function buildMenu(handlers: Parameters<typeof installMenu>[0]): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: PRODUCT_NAME,
            submenu: [
              { role: 'about', label: t('menu.about', { app: PRODUCT_NAME }) },
              { type: 'separator' },
              { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: () => handlers.onCommand('toggleSettings') },
              { type: 'separator' },
              { role: 'hide', label: t('menu.hide', { app: PRODUCT_NAME }) },
              { role: 'hideOthers', label: t('menu.hideOthers') },
              { role: 'unhide', label: t('menu.showAll') },
              { type: 'separator' },
              { role: 'quit', label: t('menu.quit', { app: PRODUCT_NAME }) }
            ]
          }
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.openProjectFolder'),
          accelerator: 'CmdOrCtrl+O',
          click: () => handlers.onOpenFolder()
        },
        {
          label: t('menu.quickOpen'),
          accelerator: 'CmdOrCtrl+P',
          click: () => handlers.onCommand('quickOpen')
        },
        { label: t('menu.save'), accelerator: 'CmdOrCtrl+S', click: () => handlers.onCommand('saveFile') },
        // macOS はアプリメニューに置く（OS の慣習）。ほかの OS はファイルメニューに置く
        ...(isMac ? [] : [{ label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: () => handlers.onCommand('toggleSettings') }]),
        { type: 'separator' },
        // role 'close' の既定は ⌘W で、ターミナル（ペイン／タブ）を閉じる ⌘W とぶつかるため ⌘⇧W にする
        isMac
          ? { role: 'close', label: t('menu.closeWindow'), accelerator: 'Cmd+Shift+W' }
          : { role: 'quit', label: t('menu.exit') }
      ]
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') }
      ]
    },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.toggleRecording'), accelerator: 'CmdOrCtrl+Shift+R', click: () => handlers.onCommand('toggleRecording') },
        {
          label: t('menu.toggleMode'),
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => handlers.onCommand('toggleMode')
        },
        {
          // サイドバーの開閉。既存のADEと同じ割り当てにする
          label: t('menu.toggleSidebar'),
          accelerator: 'CmdOrCtrl+B',
          click: () => handlers.onCommand('toggleSidebar')
        },
        {
          label: t('menu.toggleExplorer'),
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => handlers.onCommand('toggleExplorer')
        },
        {
          // フィードバックモードの右パネル（レビュー対象の一覧）。録画中に画面を広く使いたいときに隠す
          label: t('menu.toggleTargets'),
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => handlers.onCommand('toggleTargets')
        },
        {
          label: t('menu.toggleTerminalPanel'),
          accelerator: 'CmdOrCtrl+J',
          click: () => handlers.onCommand('toggleTerminalPanel')
        },
        { label: t('menu.toggleFooter'), click: () => handlers.onCommand('toggleFooter') },
        {
          label: t('menu.toggleViewport'),
          accelerator: 'CmdOrCtrl+Shift+V',
          click: () => handlers.onCommand('toggleViewport')
        },
        { type: 'separator' },
        {
          label: t('menu.focusUrl'),
          accelerator: 'CmdOrCtrl+L',
          click: () => handlers.onCommand('focusUrl')
        },
        {
          label: t('menu.reloadPage'),
          accelerator: 'CmdOrCtrl+R',
          click: () => handlers.onCommand('reloadPage')
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.fullscreen') },
        { role: 'toggleDevTools', label: t('menu.devTools') },
        {
          // 共通部品の一覧。画面を作るときの参照先（NF-13）
          label: t('menu.gallery'),
          accelerator: 'CmdOrCtrl+Shift+U',
          click: () => handlers.onCommand('toggleGallery')
        }
      ]
    },
    {
      label: t('menu.terminal'),
      submenu: [
        {
          label: t('menu.newTerminal'),
          accelerator: 'CmdOrCtrl+T',
          click: () => handlers.onCommand('newTerminal')
        },
        {
          label: t('menu.closeTerminal'),
          accelerator: 'CmdOrCtrl+W',
          click: () => handlers.onCommand('closeTerminal')
        },
        { type: 'separator' },
        // Orca と同じ割り当て（~/bench/orca/src/shared/keybindings/definitions-core-4.ts）。
        // macOS は ⌘D / ⌘⇧D、Windows / Linux は Ctrl+Shift+D / Alt+Shift+D。
        // Orca と同じく、ターミナルにフォーカスがあるときだけ効かせるので、キーは TerminalPane が拾う。
        // メニューは表示だけ（エディタの ⌘D「次の一致を選択に追加」を奪わない）。
        // registerAccelerator は Windows / Linux にしか効かないため、macOS はショートカットを名前に書く
        isMac
          ? { label: `${t('menu.splitRight')} (⌘D)`, click: () => handlers.onCommand('splitTerminalRight') }
          : {
              label: t('menu.splitRight'),
              accelerator: 'Ctrl+Shift+D',
              registerAccelerator: false,
              click: () => handlers.onCommand('splitTerminalRight')
            },
        isMac
          ? { label: `${t('menu.splitDown')} (⌘⇧D)`, click: () => handlers.onCommand('splitTerminalDown') }
          : {
              label: t('menu.splitDown'),
              accelerator: 'Alt+Shift+D',
              registerAccelerator: false,
              click: () => handlers.onCommand('splitTerminalDown')
            }
      ]
    },
    {
      // ヘルプ。初回起動のセットアップ（オンボーディング）を開き直す（Orca の「Setup guide」に相当）
      label: t('menu.help'),
      role: 'help',
      submenu: [{ label: t('menu.showOnboarding'), click: () => handlers.onCommand('showOnboarding') }]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
