import { contextBridge, ipcRenderer } from 'electron'
import {
  ADE_API_KEY,
  IPC_EVENT_CHANNELS,
  IPC_REQUEST_CHANNELS,
  type AdeApi,
  type IpcArgs,
  type IpcEventChannel,
  type IpcEvents,
  type IpcRequestChannel,
  type IpcResult
} from '@shared/ipc'
import { normalizeSystemLocale } from '@shared/i18n'

/**
 * contextIsolation 有効・nodeIntegration 無効のまま、宣言済みのチャネルだけを通す橋。
 * 許可リストは src/shared/ipc.ts が正本で、未宣言のチャネルは呼べない。
 */

const requestChannels = new Set<string>(IPC_REQUEST_CHANNELS)
const eventChannels = new Set<string>(IPC_EVENT_CHANNELS)

const api: AdeApi = {
  invoke: <C extends IpcRequestChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> => {
    if (!requestChannels.has(channel)) {
      return Promise.reject(new Error(`未宣言のIPCチャネルです: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<C>>
  },

  on: <C extends IpcEventChannel>(channel: C, listener: IpcEvents[C]): (() => void) => {
    if (!eventChannels.has(channel)) {
      // 宣言の無いチャネルは購読しない。ただし投げると、dev の HMR で画面だけ新しくなったとき
      // （preload は入れ替わらない）に useEffect ごと画面が落ちる（Sentry MOVIE-ADE-N / FERRET-S / FERRET-T）。
      // 何もしない購読解除を返し、警告だけ残す
      console.warn(`[preload] 未宣言のIPCイベントです（購読しません）: ${channel}`)
      return () => {}
    }
    const wrapped = (_event: unknown, ...args: unknown[]): void => {
      ;(listener as (...a: unknown[]) => void)(...args)
    }
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.off(channel, wrapped)
  },

  platform: process.platform,
  systemVersion: process.getSystemVersion(),

  // 見本データは ADE_DEMO=1 のときだけ。非表示実行(ADE_E2E)とは別の軸にして、
  // 「製品と同じ見た目のまま非表示で撮る」ことも出来るようにする
  demo: process.env.ADE_DEMO === '1',

  // main が additionalArguments で渡す（--ade-theme=light|dark）。無ければダーク
  initialTheme: process.argv.includes('--ade-theme=light') ? 'light' : 'dark',

  // main が additionalArguments で渡す（--ade-locale=en|ja）。無ければ英語
  initialLocale: normalizeSystemLocale(process.argv.find((a) => a.startsWith('--ade-locale='))?.slice('--ade-locale='.length))
}

contextBridge.exposeInMainWorld(ADE_API_KEY, api)

// 確認用（FERRET_SENTRY_TEST=preload）：読み込みの最後でわざと投げ、main の preload-error から Sentry へ届くかを見る
if (process.argv.includes('--ade-sentry-test-preload')) throw new Error('Ferret Sentry test: preload error')
