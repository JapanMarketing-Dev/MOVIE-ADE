/**
 * 録画中の文字起こしの途中経過を受け取る（main の pipeline/stt/liveFeed.ts が送る）。
 * パネルを閉じていても受け取り続ける（開いたときに、それまでの文字が見えるように）。
 */
import { useEffect, useRef, useState } from 'react'
import {
  IDLE_LIVE_STATUS, addLiveSegments, sanitizeLiveBatch, sanitizeLiveStatus,
  type LiveTranscriptSegment, type LiveTranscriptStatus
} from '@shared/liveTranscript'
import { subscribeIpc } from './ipcEvents'

export function useLiveTranscript(): { status: LiveTranscriptStatus; segments: LiveTranscriptSegment[] } {
  const [status, setStatus] = useState<LiveTranscriptStatus>(IDLE_LIVE_STATUS)
  const [segments, setSegments] = useState<LiveTranscriptSegment[]>([])
  const run = useRef(0)
  useEffect(() => {
    const offs = [
      subscribeIpc('transcript:status', (raw) => {
        const next = sanitizeLiveStatus(raw)
        // 新しい録画が始まったら、前の録画の文字は捨てる
        if (next.run !== run.current) { run.current = next.run; setSegments([]) }
        setStatus(next)
      }, 'stt'),
      subscribeIpc('transcript:segments', (raw) => {
        const batch = sanitizeLiveBatch(raw)
        if (!batch || batch.run !== run.current || batch.segments.length === 0) return
        setSegments((prev) => addLiveSegments(prev, batch.segments))
      }, 'stt')
    ]
    return () => offs.forEach((off) => off())
  }, [])
  return { status, segments }
}
