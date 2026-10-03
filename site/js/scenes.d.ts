// scenes.js の型（テストから import するため）。実装は scenes.js
export const SCENE_W: number
export const SCENE_H: number
export const sceneNames: string[]
export function drawScene(ctx: CanvasRenderingContext2D, name: string, t: number, poster?: boolean): void
export const APP_W: number
export const APP_H: number
export const APP_TABS: string[]
export const APP_LOOP: number
export function drawApp(ctx: CanvasRenderingContext2D, tab: string, t: number, poster?: boolean): void
