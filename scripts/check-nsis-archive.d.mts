// scripts/check-nsis-archive.mjs の型（単体テストから読むため）
export declare function findArchiveProblems(
  testOutput: string,
  listOutput: string
): { unsupported: string[]; badMethods: Array<{ path: string; method: string }> }
