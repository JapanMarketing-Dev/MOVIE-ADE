// scripts/check-win-unpacked.mjs の型（単体テストから読むため）
export declare const PE_MACHINE: { x64: number; arm64: number }
export declare function peMachine(head: Buffer): number | null
export declare function checkWinUnpacked(dir: string, arch: string): string[]
