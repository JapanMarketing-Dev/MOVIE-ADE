import { useEffect, useRef, useState, type DragEvent } from 'react'
import { hasExternalFiles } from '../lib/externalDrop'
import { hasTreePaths, treeDragPaths } from '../lib/treeDrag'
import '../styles/externalDrop.css'

/** dragover はドラッグ中に続けて届く。これだけ途切れたら、外へ出た・止めたとみなして強調を消す */
const OVER_TIMEOUT_MS = 250

/**
 * 外（Finder・デスクトップ・エクスプローラー）からファイル・フォルダを落とせる場所。
 * 'Files' を運ぶドラッグのときだけ受け、タブ・パネルの並べ替えのドラッグには反応しない。
 * onDrop には DataTransfer をそのまま渡す（files はイベントの間しか読めないので、受け取ったらすぐ readDrop へ）。
 * onTreeDrop を渡すと、ファイルツリーの行のドラッグ（プロジェクトの根からの相対パス）も受ける
 */
export function useExternalDrop(onDrop: (dataTransfer: DataTransfer) => void, enabled = true, onTreeDrop?: (relPaths: string[]) => void) {
  const [over, setOver] = useState(false)
  const timer = useRef<number | null>(null)
  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  const reset = () => {
    clearTimer()
    setOver(false)
  }
  useEffect(() => clearTimer, [])
  const accepts = (e: DragEvent<HTMLElement>) => enabled && (hasExternalFiles(e.dataTransfer) || (!!onTreeDrop && hasTreePaths(e.dataTransfer)))
  // 捕捉の段階で受け、中のエディタなど（ファイルの中身を差し込む既定の処理）へは渡さない
  const props = {
    onDragEnterCapture: (e: DragEvent<HTMLElement>) => {
      if (!accepts(e)) return
      e.preventDefault()
      e.stopPropagation()
    },
    onDragOverCapture: (e: DragEvent<HTMLElement>) => {
      if (!accepts(e)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      if (!over) setOver(true)
      clearTimer()
      timer.current = window.setTimeout(reset, OVER_TIMEOUT_MS)
    },
    onDragLeaveCapture: (e: DragEvent<HTMLElement>) => {
      if (!accepts(e)) return
      e.stopPropagation()
      if (!e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget) reset()
    },
    onDropCapture: (e: DragEvent<HTMLElement>) => {
      if (!accepts(e)) return
      e.preventDefault()
      e.stopPropagation()
      reset()
      const tree = treeDragPaths(e.dataTransfer)
      if (tree) onTreeDrop?.(tree)
      else onDrop(e.dataTransfer)
    }
  }
  return { over, props }
}

/** 落とせる場所の強調（親に .external-drop-host を付ける） */
export function ExternalDropOverlay({ label, testId, align }: { label: string; testId?: string; align?: 'top' }) {
  return (
    <div className="external-drop-overlay" data-testid={testId} data-align={align}>
      <span className="external-drop-overlay__label">{label}</span>
    </div>
  )
}
