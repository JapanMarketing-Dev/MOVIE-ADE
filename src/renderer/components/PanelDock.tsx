import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GripHorizontal } from 'lucide-react'
import { allowedDocks, dockFromPoint, dropPanel, dropPreviewRect, type Dock, type DragPanel, type Rect } from '@shared/layout'
import { useT } from '../lib/i18n'
import { setLayout } from '../lib/layout'

/**
 * パネルをドラッグして画面の上下左右の端へ運び、置き場所を変える（VS Code / Orca と同じ操作）。
 *
 * - 各パネルの上端中央に小さなつまみ（PanelGrip）を出す。掴むとドラッグが始まる
 * - ドラッグ中はワークスペースの上に覆いを出し、落とす先の端を半透明の帯で示す
 * - 中央寄りで離す・Esc で取りやめ。離すとその端へ移り、設定の「レイアウト」も同じ値になる
 * - ⚠ 内蔵ブラウザのビューはDOMの上に重なり、その上ではポインターが renderer に届かない。
 *   ドラッグ中は App がビューを隠す（usePanelDrag の dragging を viewVisible に入れる）
 *
 * 落とす先の判定は純粋関数（src/shared/layout.ts の dockFromPoint）で、単体テストがある。
 * HTML5 の DnD ではなくポインターイベントにしたのは、ターミナル（xterm）やタブの DnD と混ざらないため。
 */

interface DragState {
  panel: DragPanel
  dock: Dock | null
  rect: Rect
}

/** ドラッグの状態と、つまみから呼ぶ開始関数 */
export function usePanelDrag(): { drag: DragState | null; start: (panel: DragPanel, e: React.PointerEvent) => void } {
  const [drag, setDrag] = useState<DragState | null>(null)
  const latest = useRef<DragState | null>(null)
  latest.current = drag

  const start = useCallback((panel: DragPanel, e: React.PointerEvent) => {
    if (e.button !== 0) return
    // ターミナルは本体（中央のタブ群）の周りに付くので、本体の枠で判定・表示する。ほかはワークスペース全体
    const area = document.querySelector(panel === 'terminal' ? '.shell--editor .main-split' : '.shell--editor .workspace')?.getBoundingClientRect()
    if (!area) return
    e.preventDefault()
    const rect: Rect = { left: area.left, top: area.top, width: area.width, height: area.height }
    const allowed = allowedDocks(panel)
    setDrag({ panel, dock: null, rect })
    document.body.dataset.panelDragging = 'true'

    const move = (ev: PointerEvent) => {
      const dock = dockFromPoint(ev.clientX, ev.clientY, rect, allowed)
      setDrag((cur) => (cur && cur.dock !== dock ? { ...cur, dock } : cur))
    }
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      delete document.body.dataset.panelDragging
      const last = latest.current
      setDrag(null)
      if (commit && last?.dock) {
        const dock = last.dock
        setLayout((prev) => dropPanel(prev, panel, dock))
      }
    }
    const up = (ev: PointerEvent) => {
      // 最後の位置で決め直す（move が描画に間に合わなかった場合）
      const dock = dockFromPoint(ev.clientX, ev.clientY, rect, allowed)
      if (latest.current) latest.current = { ...latest.current, dock }
      finish(true)
    }
    const cancel = () => finish(false)
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
  }, [])

  return { drag, start }
}

/** パネルの上端中央のつまみ。グリッドの同じ領域に重ねて置く */
export function PanelGrip({ panel, area, hidden, onStart }: {
  panel: DragPanel
  /** 重ねる grid-area（projects / files / term）。フッターの中に置くときは省略 */
  area?: string
  hidden?: boolean
  onStart: (panel: DragPanel, e: React.PointerEvent) => void
}) {
  const t = useT()
  const name = t(`settings.layout.panel.${panel}`)
  // フッターは上か下にしか置けないので、案内もそれに合わせる
  const label = t(panel === 'footer' ? 'layout.drag.gripFooter' : 'layout.drag.grip', { panel: name })
  return (
    <button
      type="button"
      className={`panel-grip${area ? '' : ' panel-grip--inline'}`}
      style={area ? { gridArea: area } : undefined}
      hidden={hidden}
      aria-label={label}
      title={label}
      onPointerDown={(e) => onStart(panel, e)}
      data-testid={`panel-grip-${panel}`}
    >
      <GripHorizontal size={12} strokeWidth={2} aria-hidden="true" />
    </button>
  )
}

/** ドラッグ中の覆い。落とす先の端を半透明の帯で示す */
export function DockOverlay({ drag }: { drag: DragState | null }) {
  const t = useT()
  useEffect(() => {
    if (!drag) return
    document.body.style.cursor = 'grabbing'
    return () => { document.body.style.cursor = '' }
  }, [drag])
  if (!drag) return null
  const preview = drag.dock ? dropPreviewRect(drag.dock, drag.rect) : null
  const name = t(`settings.layout.panel.${drag.panel}`)
  return createPortal(
    <div className="dock-overlay" style={{ left: drag.rect.left, top: drag.rect.top, width: drag.rect.width, height: drag.rect.height }} data-testid="dock-overlay" data-dock={drag.dock ?? ''}>
      {preview && <div className="dock-overlay__preview" style={{ left: preview.left, top: preview.top, width: preview.width, height: preview.height }} />}
      <div className="dock-overlay__label">
        {drag.dock ? t('layout.drag.drop', { panel: name, dock: t(`settings.layout.dock.${drag.dock}`) }) : t('layout.drag.cancel')}
      </div>
    </div>,
    document.body
  )
}
