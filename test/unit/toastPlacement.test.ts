import { describe, expect, it } from 'vitest'
import { TOAST_MAX_WIDTH, TOAST_MIN_WIDTH, toastPlacement } from '../../src/renderer/lib/toastPlacement'

const viewport = (width: number, height = 768) => ({ width, height })

describe('トーストの置き場所（内蔵ブラウザのビューに隠れない）', () => {
  it('ビューが無いときは右上の既定の幅', () => {
    expect(toastPlacement(null, viewport(1440))).toEqual({ kind: 'side', side: 'right', offset: 16, width: TOAST_MAX_WIDTH })
  })

  it('1440px で右パネルが広いときは、右パネルの上に既定の幅で置く', () => {
    const view = { x: 0, y: 52, width: 1000, height: 716 }
    expect(toastPlacement(view, viewport(1440))).toEqual({ kind: 'side', side: 'right', offset: 16, width: TOAST_MAX_WIDTH })
  })

  it('1024px で右パネルが狭いときは、右パネルの幅に縮めて、ビューに重ねない', () => {
    const view = { x: 0, y: 52, width: 716, height: 716 }
    const placement = toastPlacement(view, viewport(1024))
    expect(placement).toEqual({ kind: 'side', side: 'right', offset: 16, width: 1024 - 716 - 32 })
    // 右端から置いたトーストの左端が、ビューの右端より右にある
    if (placement.kind === 'side') expect(1024 - placement.offset - placement.width).toBeGreaterThanOrEqual(716)
  })

  it('右より左（サイドバー）が広ければ左に置く', () => {
    const view = { x: 400, y: 120, width: 560, height: 600 }
    expect(toastPlacement(view, viewport(1024))).toMatchObject({ kind: 'side', side: 'left', width: 368 })
  })

  it('左右とも狭く、ビューの上の帯（タブ・URL欄）が高ければ帯に重ねる', () => {
    const view = { x: 0, y: 136, width: 1024, height: 600 }
    expect(toastPlacement(view, viewport(1024))).toEqual({ kind: 'band', width: TOAST_MAX_WIDTH, maxHeight: 112 })
  })

  it('右パネルを閉じたフィードバックモード（帯が低い）では、ツールバーの案内の枠へ回す', () => {
    const view = { x: 0, y: 52, width: 1024, height: 716 }
    expect(toastPlacement(view, viewport(1024))).toEqual({ kind: 'notice' })
  })

  it('最小の幅に満たない隙間には置かない', () => {
    const view = { x: 0, y: 52, width: 1024 - (TOAST_MIN_WIDTH + 31), height: 716 }
    expect(toastPlacement(view, viewport(1024)).kind).toBe('notice')
  })
})
