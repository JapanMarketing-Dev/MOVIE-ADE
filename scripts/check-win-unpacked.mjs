/**
 * Mac で作った Windows の展開済みアプリ（win-unpacked / win-arm64-unpacked）の中身を確かめる。実機の無いところでの検査。
 *
 *   node scripts/check-win-unpacked.mjs dist/release/win-unpacked x64
 *   node scripts/check-win-unpacked.mjs dist/release/win-arm64-unpacked arm64
 *
 * - Ferret.exe・ffmpeg.dll と node-pty のネイティブ部品（pty.node・conpty.node・conpty.dll・OpenConsole.exe）があり、
 *   どれも指定の CPU 向けの PE であること（x64 版に arm64 の部品が入る、またはその逆の取り違えを止める）
 * - node-pty の prebuilds に、ほかの OS / CPU 向けのものと、この Mac で作った build/ が入っていないこと
 * - app.asar とウインドウのアイコン（resources/icon.png）があること
 */
import { existsSync, openSync, readSync, closeSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** PE のヘッダの Machine の値 */
export const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 }

/** ファイルの先頭（1KB 以上）から PE の Machine を読む。PE でなければ null（純粋関数。test/unit で確かめる） */
export function peMachine(head) {
  if (head.length < 0x40 || head[0] !== 0x4d || head[1] !== 0x5a) return null // MZ
  const offset = head.readUInt32LE(0x3c)
  if (offset + 6 > head.length) return null
  if (head.toString('latin1', offset, offset + 4) !== 'PE\0\0') return null
  return head.readUInt16LE(offset + 4)
}

function readHead(path) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

/** 展開済みアプリの問題の一覧（無ければ空） */
export function checkWinUnpacked(dir, arch) {
  const want = PE_MACHINE[arch]
  if (!want) return [`知らない CPU です: ${arch}（x64 か arm64）`]
  const problems = []
  const pty = join(dir, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty')
  const binaries = ['Ferret.exe', 'ffmpeg.dll', ...['pty.node', 'conpty.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'].map((f) => join('resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', `win32-${arch}`, f))]
  for (const rel of binaries) {
    const path = join(dir, rel)
    if (!existsSync(path)) { problems.push(`${rel} がありません`); continue }
    const machine = peMachine(readHead(path))
    if (machine !== want) problems.push(`${rel} が ${arch} 向けではありません（Machine 0x${(machine ?? 0).toString(16)}）`)
  }
  for (const rel of [join('resources', 'app.asar'), join('resources', 'icon.png')]) {
    if (!existsSync(join(dir, rel))) problems.push(`${rel} がありません`)
  }
  const prebuilds = existsSync(join(pty, 'prebuilds')) ? readdirSync(join(pty, 'prebuilds')) : []
  for (const name of prebuilds) if (name !== `win32-${arch}`) problems.push(`node-pty の prebuilds/${name} が入っています`)
  if (existsSync(join(pty, 'build'))) problems.push('node-pty の build/（この Mac で作ったもの）が入っています')
  return problems
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, arch] = process.argv.slice(2)
  if (!dir || !arch) {
    console.error('使い方: node scripts/check-win-unpacked.mjs <win-unpacked のフォルダ> <x64|arm64>')
    process.exit(2)
  }
  const problems = checkWinUnpacked(resolve(dir), arch)
  if (problems.length > 0) {
    for (const p of problems) console.error(`NG ${p}`)
    process.exit(1)
  }
  console.log(`OK ${dir} (${arch})`)
}
