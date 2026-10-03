import { app } from 'electron'
import { isPackagedBuild } from './runtimeKind'

/**
 * 配布版か。main で配布版・開発版を分けるところは、app.isPackaged ではなく必ずこれを使う
 * （名前を変えた開発版の Electron でも app.isPackaged は true になるため。src/main/runtimeKind.ts）。
 * 起動時に1度だけ決める。test/unit/runtime-packaged.test.ts が app.isPackaged の直接の使用を落とす。
 */
export const IS_PACKAGED: boolean = isPackagedBuild({
  isPackaged: app?.isPackaged === true,
  defaultApp: process.defaultApp,
  rendererUrl: process.env.ELECTRON_RENDERER_URL
})
