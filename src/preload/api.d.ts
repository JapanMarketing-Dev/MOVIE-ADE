import type { AdeApi } from '@shared/ipc'

/** preload が公開する API を renderer から型つきで使うための宣言 */
declare global {
  interface Window {
    ade: AdeApi
  }
}

export {}
