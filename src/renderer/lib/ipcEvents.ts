import type { IpcEventChannel, IpcEvents } from '@shared/ipc'
import { reportHandled, type ReportArea } from '@shared/report'

/**
 * main からの知らせを購読する。購読できなくても画面は止めない。
 *
 * preload は dev の再読み込み（HMR）で入れ替わらないので、新しいチャネルを足した直後に dev を再起動しないと、
 * 古い preload が「未宣言のIPCイベント」で断る（Sentry MOVIE-ADE-N）。useEffect の中で投げると画面ごと落ちるので、
 * ここで受け止めてチャネルごとに1回だけ送り、何もしない購読解除を返す。
 */
const reported = new Set<string>()

export function subscribeIpc<C extends IpcEventChannel>(channel: C, listener: IpcEvents[C], area: ReportArea): () => void {
  try {
    return window.ade.on(channel, listener)
  } catch (err) {
    if (!reported.has(channel)) {
      reported.add(channel)
      reportHandled(err, { area, op: 'subscribe ipc event' })
    }
    return () => {}
  }
}
