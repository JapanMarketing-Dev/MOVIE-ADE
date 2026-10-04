import type { UpdateCheckResult } from './appVersion'

/**
 * 裏での更新（ダウンロード → 署名の確認 → 再起動して入れ替え）の状態。main（src/main/autoUpdate.ts）が持ち、
 * フッターの「アップデート」のポップオーバーとフッターの「再起動して更新」が表示に使う。
 *
 * Orca由来: ~/bench/orca/src/shared/update-status-types.ts（MIT）の UpdateStatus の段階
 * （available → downloading(percent) → downloaded → error）。Orca は electron-updater の状態をそのまま出すが、
 * このアプリは署名した SHA256SUMS で確かめたファイルだけを使うので、段階は自前で持つ。
 */

/** OS ごとの入れ替えの方法。null はこの起動では入れ替えられない（開発版・入れ替えの方法が無い形） */
export type InstallMethod =
  /** macOS: 確かめた zip を Squirrel.Mac（Electron の autoUpdater）に渡し、再起動で入れ替える */
  | 'squirrel-mac'
  /** Windows: 確かめた NSIS のインストーラーを、画面なし（/S）で走らせて入れ替え、終わったら起動し直す */
  | 'nsis'
  /** Linux の AppImage: 確かめた AppImage を今のファイルの場所に置き、起動し直す */
  | 'appimage'
  /** Linux の deb: 自動では入れ替えない。確かめた .deb を「インストール」でソフトウェアのインストーラーに開く */
  | 'deb'

/** この OS で入れ替えに使うファイルの種類（latest.json の files / updates の kind） */
export const INSTALL_KIND: Record<InstallMethod, 'zip' | 'exe' | 'AppImage' | 'deb'> = {
  'squirrel-mac': 'zip',
  nsis: 'exe',
  appimage: 'AppImage',
  deb: 'deb'
}

/** 動いている OS と形から、入れ替えの方法を決める。AppImage は起動時に APPIMAGE（実行ファイルの場所）が入る */
export function installMethodFor(platform: string, env: Record<string, string | undefined>): InstallMethod | null {
  if (platform === 'darwin') return 'squirrel-mac'
  if (platform === 'win32') return 'nsis'
  if (platform === 'linux') return env.APPIMAGE?.startsWith('/') ? 'appimage' : 'deb'
  return null
}

export type AutoUpdateProgress =
  | { phase: 'idle' }
  /** 裏でダウンロード中（percent は 0〜100） */
  | { phase: 'downloading'; version: string; percent: number }
  /** 署名と中身を確かめ終えた。restart … 再起動で入れ替える / open-installer … deb のインストーラーを開く */
  | { phase: 'ready'; version: string; action: 'restart' | 'open-installer' }
  /** ダウンロード・確認・入れ替えの準備ができなかった。［もう一度］で始め直せる */
  | { phase: 'failed'; version: string; message: string }

export interface AutoUpdateStatus {
  /** 最後の更新の確認の結果（起動時・一定間隔・［更新を確認］）。まだなら null */
  check: UpdateCheckResult | null
  /** いま確認している */
  checking: boolean
  progress: AutoUpdateProgress
  /** 新しい版を見つけたら裏でダウンロードする（設定の autoUpdate。既定はオン） */
  autoDownload: boolean
  /** この起動で裏のダウンロードと入れ替えができる（配布版で、この OS・形に入れ替えの方法があり、その版にファイルがある） */
  supported: boolean
}

/** 自動更新を一定間隔で確かめる間隔（6時間）。Orca は 24 時間 + 起動・復帰時（~/bench/orca/src/main/updater/updater-state.ts） */
export const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 起動してから最初に確かめるまで（起動の重さに重ねない） */
export const AUTO_UPDATE_FIRST_CHECK_MS = 20 * 1000
