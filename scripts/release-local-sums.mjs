/**
 * 署名する SHA256SUMS / UPDATE-SHA256SUMS を、手元の配布物（scripts/build-release.sh が作った dist/release）を
 * 自分でハッシュして作る（security-5 [8]）。
 *
 * 署名の鍵は、R2 の書き込み権を持つ人が配布物を差し替えても気づけるように R2 とは別に持っている。
 * その鍵で R2 の manifest に書かれた値をそのまま署名すると、R2 を書き換えられたときに偽の値に署名してしまう。
 * そこで署名の材料は手元のファイルのハッシュだけにし、R2 の manifest は「手元と過不足なく同じか」を確かめるためだけに使う。
 * 違えば署名しない（promote は署名した値と R2 のファイルのハッシュを突き合わせる）。
 */
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { formatSha256Sums, parseArtifactName, parseUpdateArtifactName } from './release-r2-lib.mjs'

function sha256File(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolvePromise(hash.digest('hex'))).on('error', reject)
  })
}

/**
 * フォルダの中の、その版の配布物（files）と自動更新用のファイル（updates）を読み、大きさと sha256 を求める。
 * 名前の規則に合わないもの（.blockmap・BUILD-PROVENANCE.txt など）は数えない。通常のファイル以外（シンボリックリンクなど）は止める
 * @param {string} dir
 * @param {string} version
 * @returns {Promise<{ files: Array<{ name: string, size: number, sha256: string }>, updates: Array<{ name: string, size: number, sha256: string }> }>}
 */
export async function hashLocalArtifacts(dir, version) {
  const files = []
  const updates = []
  for (const name of readdirSync(dir).sort()) {
    const target = parseArtifactName(name, version) ? files : parseUpdateArtifactName(name, version) ? updates : null
    if (!target) continue
    const path = join(dir, name)
    const st = lstatSync(path)
    if (!st.isFile()) throw new Error(`${path} が通常のファイルではありません`)
    target.push({ name, size: st.size, sha256: await sha256File(path) })
  }
  if (files.length === 0) throw new Error(`${dir} に ${version} の配布物がありません（先に pnpm release:build で作る）`)
  return { files, updates }
}

/** 手元の一覧と manifest の一覧が、名前・大きさ・sha256 まで過不足なく同じかを確かめる */
function assertSameSet(label, local, remote) {
  const byName = new Map(local.map((f) => [f.name, f]))
  for (const r of remote) {
    const l = byName.get(r.name)
    if (!l) throw new Error(`${label}: manifest にある ${r.name} が手元にありません`)
    if (l.sha256 !== r.sha256 || l.size !== r.size) {
      throw new Error(`${label}: ${r.name} の sha256 か大きさが手元のファイルと違います（R2 の manifest かファイルが書き換えられた可能性があります）。署名しません`)
    }
    byName.delete(r.name)
  }
  if (byName.size > 0) throw new Error(`${label}: 手元の ${[...byName.keys()].join(', ')} が manifest にありません`)
}

/**
 * 署名する SHA256SUMS（と UPDATE-SHA256SUMS）の本文を、手元のハッシュから作る。
 * manifest（R2 の staging か --manifest）は手元と過不足なく同じことを確かめるだけで、値は使わない
 * @param {{ files: Array<{ name: string, size: number, sha256: string }>, updates: Array<{ name: string, size: number, sha256: string }> }} local hashLocalArtifacts の結果
 * @param {{ files: Array<{ name: string, size: number, sha256: string }>, updates?: Array<{ name: string, size: number, sha256: string }> }} manifest
 * @returns {{ sums: string, updateSums: string | null }}
 */
export function signedSumsFromLocal(local, manifest) {
  if (local.files.length === 0) throw new Error('手元に配布物がありません')
  assertSameSet('配布物', local.files, manifest.files)
  assertSameSet('自動更新のファイル', local.updates, manifest.updates ?? [])
  return {
    sums: formatSha256Sums(local.files),
    updateSums: local.updates.length > 0 ? formatSha256Sums(local.updates) : null
  }
}
