/**
 * pnpm dev の入口。macOS では名前とアイコンを Ferret にした Electron.app（scripts/prepare-dev-electron.mjs）を
 * ELECTRON_EXEC_PATH に入れてから electron-vite dev を起動する。ほかの OS はそのまま electron-vite dev。
 * 引数は electron-vite へそのまま渡す。
 */
import { spawn } from 'node:child_process'
import { prepareDevElectron } from './prepare-dev-electron.mjs'
import { localBinInvocation } from './release-tools.mjs'

const env = { ...process.env }
if (!env.ELECTRON_EXEC_PATH) {
  try {
    const executable = prepareDevElectron()
    if (executable) env.ELECTRON_EXEC_PATH = executable
  } catch (err) {
    console.warn(`[dev-electron] Ferret.app（開発版）を用意できませんでした。Electron のまま起動します: ${err.message}`)
  }
}

// .bin の .cmd を経由せず、electron-vite の JS を node で直接動かす（shell を使わないので、引数もそのまま渡る）
const vite = localBinInvocation('electron-vite', 'electron-vite', ['dev', ...process.argv.slice(2)])
const child = spawn(vite.command, vite.args, { stdio: 'inherit', env, shell: false })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
