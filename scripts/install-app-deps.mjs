/**
 * ネイティブモジュール（node-pty）を Electron 向けに用意する。インストールの最後に走る。
 *
 * - macOS / Linux: electron-builder install-app-deps で build/Release を作る（Linux は prebuilds が無いのでこれが本体）
 * - Windows: node-pty 1.1 は N-API で、prebuilds/win32-<cpu> を同梱している。作り直すには
 *   Visual Studio の C++ ビルドツールが要り、無い環境ではインストールごと失敗するので、作り直さない。
 *   どうしても作り直すときは ADE_FORCE_NATIVE_REBUILD=1 を付ける。
 */
import { localBinInvocation, runTool } from './release-tools.mjs'

if (process.platform === 'win32' && process.env.ADE_FORCE_NATIVE_REBUILD !== '1') {
  console.log('[native] Windows は node-pty の同梱バイナリを使います（作り直しはしません）')
  process.exit(0)
}

// .bin の .cmd を経由せず、electron-builder の JS を node で直接動かす（shell を使わない）
const result = runTool(localBinInvocation('electron-builder', 'electron-builder', ['install-app-deps']), { stdio: 'inherit' })
process.exit(result.status ?? 1)
