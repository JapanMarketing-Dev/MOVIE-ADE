// scripts/release-local-sums.mjs の型（単体テストから読むため）

export interface LocalArtifact {
  name: string
  size: number
  sha256: string
}

export function hashLocalArtifacts(dir: string, version: string): Promise<{ files: LocalArtifact[]; updates: LocalArtifact[] }>
export function signedSumsFromLocal(
  local: { files: LocalArtifact[]; updates: LocalArtifact[] },
  manifest: { files: LocalArtifact[]; updates?: LocalArtifact[] }
): { sums: string; updateSums: string | null }
