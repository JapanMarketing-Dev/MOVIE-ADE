/**
 * pnpm dev の入口。macOS では名前とアイコンを Ferret にした Electron.app（scripts/prepare-dev-electron.mjs）を
 * ELECTRON_EXEC_PATH に入れてから electron-vite dev を起動する。ほかの OS はそのまま electron-vite dev。
 * 引数は electron-vite へそのまま渡す。
 */
import { spawn } from 'node:child_process'
import { prepareDevElectron } from './prepare-dev-electron.mjs'

const env = { ...process.env }
if (!env.ELECTRON_EXEC_PATH) {
  try {
    const executable = prepareDevElectron()
    if (executable) env.ELECTRON_EXEC_PATH = executable
  } catch (err) {
    console.warn(`[dev-electron] Ferret.app（開発版）を用意できませんでした。Electron のまま起動します: ${err.message}`)
  }
}

const child = spawn('electron-vite', ['dev', ...process.argv.slice(2)], { stdio: 'inherit', env, shell: process.platform === 'win32' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
