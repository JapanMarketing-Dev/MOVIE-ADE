// scripts/check-nsis-paths.mjs の型（単体テストから読むため）
export declare const NSIS_PATH_LIMIT: number
export declare function nsisPathProblem(longestPath: string, limit?: number): string | null
export declare function longestFilePath(dir: string): string
export declare function nsisTemplatesDir(projectDir: string): string
