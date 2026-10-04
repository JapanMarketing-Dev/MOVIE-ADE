/**
 * 内蔵ブラウザの User-Agent から、Electron と Ferret の印を外す（純粋な関数。単体テストの対象）。
 *
 * Electron の既定の UA には「ferret/0.4.0 Electron/44.x」が入り、Google などのログインが
 * 「安全でないブラウザ」として断る（Orca #6711 #10468 #18562）。Chrome と同じ形に戻す。
 * Orca由来: ~/bench/orca/src/main/browser/browser-process-user-agent.ts の cleanElectronUserAgent（MIT）。
 * Chromium の形（"(KHTML, like Gecko)" を含む）のときだけ手を入れ、それ以外はそのまま返す
 */
const CHROMIUM_ENGINE_COMMENT = '(KHTML, like Gecko)'

export function cleanElectronUserAgent(userAgent: string): string {
  if (!userAgent.includes(CHROMIUM_ENGINE_COMMENT)) return userAgent
  return userAgent
    .replace(/\s+Electron\/\S+/, '')
    // エンジンの注記と Chrome/ の間にあるアプリの印（「Ferret Dev/1.0」のような空白入りも）を外す
    .replace(/(\)\s+)(?:[^)\s]+\s+)*?(Chrome\/)/, '$1$2')
}
