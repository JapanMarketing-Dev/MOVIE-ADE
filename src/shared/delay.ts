/** ms ミリ秒待つ（main と renderer で共通） */
export function delay(ms: number): Promise<void> {
  return new Promise<void>((done) => setTimeout(done, ms))
}
