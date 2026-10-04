/**
 * 録画で使うマイクの名前（録画ツールバーに出す。どのマイクにつながっているか分かるように）。
 * 選んでいない（システムの既定）ときは、Chromium の一覧の 'default'（「Default - MacBook Pro のマイク」など）から実際の機器の名前を取る。
 * 名前が分からなければ null（呼び出し側が「システムの既定」と出す）
 */
export function micDeviceName(deviceId: string, devices: ReadonlyArray<{ id: string; label: string }>): string | null {
  if (deviceId) return devices.find((d) => d.id === deviceId)?.label ?? null
  const fallback = devices.find((d) => d.id === 'default')?.label
  if (!fallback) return null
  // 「Default - 」「既定 - 」のような前置き（OS・言語で変わる）を外す
  const stripped = fallback.replace(/^[^-–]{1,24}\s[-–]\s/, '')
  return stripped || fallback
}
