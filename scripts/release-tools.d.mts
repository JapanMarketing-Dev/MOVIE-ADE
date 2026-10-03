// scripts/release-tools.mjs の型（単体テストから読むため）
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process'

export interface ToolInvocation {
  command: string
  args: string[]
}

export declare function pinnedInvocation(pkgName: string, binName: string, args: string[], rootDir?: string): ToolInvocation
export declare function wranglerInvocation(args: string[]): ToolInvocation
export declare function sentryInvocation(args: string[]): ToolInvocation
export declare function sentryCliInvocation(args: string[]): ToolInvocation
export declare function localBinInvocation(pkgName: string, binName: string, args: string[]): ToolInvocation
export declare function runTool(invocation: ToolInvocation, opts?: SpawnSyncOptions): SpawnSyncReturns<string | Buffer>
