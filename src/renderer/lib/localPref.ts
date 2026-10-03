/**
 * この端末だけの小さな好み（パネルの開閉・幅など）を localStorage に読み書きする。
 * 読めない・書けない環境（プライベートウインドウ・容量切れ）でも、既定で動くように例外を飲む。
 */
export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch { // ストレージが使えない・壊れた値（想定内。既定で続ける）
    return null
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 保存できなくても、この起動の間は効く
  }
}
