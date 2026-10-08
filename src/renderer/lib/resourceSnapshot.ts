/**
 * 起動の直後は、フッターのリソースの最初の取得を待つ。Windows は取るたびに PowerShell を起動し、起動中の main と画面の描画に重なって
 * 操作できるまでが数秒遅れていた（FERRET-K：ipc:resources:snapshot 1184ms が起動の途中に入っていた）
 */
export const FIRST_SNAPSHOT_DELAY_MS = 8000

/** 最初の取得までの待ち。画面を読み込んでから FIRST_SNAPSHOT_DELAY_MS までだけ待つ（あとは待たない） */
export function firstSnapshotDelay(sinceLoadMs: number): number {
  return Math.max(0, Math.round(FIRST_SNAPSHOT_DELAY_MS - sinceLoadMs))
}
