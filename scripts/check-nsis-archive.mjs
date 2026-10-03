/**
 * Windows のインストーラ（NSIS）の中のアーカイブを、インストーラと同じくらい古い 7-Zip で検査する。
 *
 *   node scripts/check-nsis-archive.mjs dist/release/Ferret-0.2.0-win-arm64.exe [...]
 *
 * インストーラは $PLUGINSDIR/app-<cpu>.7z を nsis7z.dll（中身は古い 7-Zip）で展開する。新しい 7-Zip が作った
 * アーカイブに、古い 7-Zip が読めないメソッド（ARM64 の分岐フィルタ 0A など）が入っていると、nsis7z は
 * エラーを出さずにそのファイルを飛ばし、Ferret.exe の無いインストールになる（0.2.0 の win-arm64 版で起きた）。
 * そこで p7zip 16 / 17（NSIS の nsis7z と同じ世代）で `7z t` し、Unsupported Method が1件でもあれば失敗にする。
 * あわせて `7z l -slt` で各ファイルのメソッドを読み、許す一覧に無いものがあれば失敗にする。
 *
 * 古い 7-Zip は Homebrew の p7zip（`brew install p7zip`、7-Zip 17.05）。SEVENZIP に別のパスも渡せる。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/** nsis7z（古い 7-Zip）が読めるメソッド。これ以外（ARM64、RISCV、新しい ARM の分岐フィルタなど）は失敗にする */
const ALLOWED_METHODS = new Set(['LZMA', 'LZMA2', 'PPMD', 'BZip2', 'Deflate', 'Deflate64', 'Copy', 'BCJ', 'BCJ2', 'ARM', 'ARMT', 'Delta', '7zAES'])

/**
 * `7z t` と `7z l -slt` の出力から、問題のあるファイルを返す（純粋関数。test/unit で確かめる）。
 * @returns {{ unsupported: string[], badMethods: Array<{ path: string, method: string }> }}
 */
export function findArchiveProblems(testOutput, listOutput) {
  const unsupported = []
  for (const line of testOutput.split(/\r?\n/)) {
    // 例: "ERROR: Unsupported Method : Ferret.exe"
    const m = /Unsupported Method\s*:\s*(.+)$/i.exec(line)
    if (m) unsupported.push(m[1].trim())
  }
  const badMethods = []
  let path = null
  // 「----------」より前はアーカイブ全体の情報（全ファイルのメソッドのまとめ）なので、各ファイルの行だけを見る
  let inFiles = false
  for (const line of listOutput.split(/\r?\n/)) {
    if (line.startsWith('----------')) inFiles = true
    if (!inFiles) continue
    if (line.startsWith('Path = ')) path = line.slice('Path = '.length)
    else if (line.startsWith('Method = ') && path !== null) {
      // 例: "LZMA2:24 BCJ" / "LZMA:24" / "0A LZMA2:24"（古い 7-Zip は知らないメソッドを番号で出す）
      const tokens = line.slice('Method = '.length).trim().split(/\s+/).filter(Boolean)
      for (const token of tokens) {
        const name = token.split(':')[0]
        if (!ALLOWED_METHODS.has(name)) badMethods.push({ path, method: token })
      }
    }
  }
  return { unsupported, badMethods }
}

function sevenZip() {
  const bin = process.env.SEVENZIP || '7z'
  const r = spawnSync(bin, [], { encoding: 'utf8' })
  if (r.error) throw new Error(`古い 7-Zip（p7zip）が見つかりません。brew install p7zip で入れるか、SEVENZIP にパスを渡してください`)
  const version = /7-Zip[^\d]*(\d+)\.(\d+)/.exec(r.stdout ?? '')
  // 24 以降は ARM64 フィルタを読めてしまうので、この検査の意味がない
  if (version && Number(version[1]) >= 23) throw new Error(`${bin} は 7-Zip ${version[1]}.${version[2]} です。nsis7z と同じ世代（16 / 17）の p7zip を使ってください`)
  return bin
}

function checkInstaller(bin, exe) {
  const work = mkdtempSync(join(tmpdir(), 'ferret-nsis-check-'))
  try {
    // インストーラ（NSIS）の中から、アプリの本体のアーカイブを取り出す
    execFileSync(bin, ['e', '-y', `-o${work}`, exe, '$PLUGINSDIR/app-*.7z'], { stdio: 'ignore' })
    const archives = readdirSync(work).filter((name) => /^app-.*\.7z$/.test(name))
    if (archives.length === 0) throw new Error(`${basename(exe)} の中に $PLUGINSDIR/app-*.7z がありません`)
    let ok = true
    for (const name of archives) {
      const archive = join(work, name)
      const test = spawnSync(bin, ['t', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      const list = spawnSync(bin, ['l', '-slt', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      const { unsupported, badMethods } = findArchiveProblems(`${test.stdout}\n${test.stderr}`, list.stdout ?? '')
      if (unsupported.length || badMethods.length || test.status !== 0) {
        ok = false
        console.error(`NG ${basename(exe)} / ${name}: 古い 7-Zip で読めないファイル ${unsupported.length} 件、許していないメソッド ${badMethods.length} 件`)
        for (const path of unsupported.slice(0, 20)) console.error(`  Unsupported Method: ${path}`)
        for (const { path, method } of badMethods.slice(0, 20)) console.error(`  ${method}: ${path}`)
      } else {
        console.log(`OK ${basename(exe)} / ${name}`)
      }
    }
    return ok
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const exes = process.argv.slice(2)
  if (exes.length === 0) {
    console.error('使い方: node scripts/check-nsis-archive.mjs <インストーラ.exe> [...]')
    process.exit(2)
  }
  const bin = sevenZip()
  const results = exes.map((exe) => checkInstaller(bin, resolve(exe)))
  process.exit(results.every(Boolean) ? 0 : 1)
}
