// hero.js の型（テストから import するため）。実装は hero.js
export const HERO_W: number
export const HERO_H: number
export const HERO_LOOP: number
export const DONE_AT: number
export type HeroState = Record<string, unknown>
export function heroState(t: number, loopIndex?: number): HeroState
export function posterState(): HeroState
export function drawHero(ctx: CanvasRenderingContext2D, state: HeroState): void
export function mountHero(canvas: HTMLCanvasElement, options?: { onFirstFrame?: () => void }): boolean
