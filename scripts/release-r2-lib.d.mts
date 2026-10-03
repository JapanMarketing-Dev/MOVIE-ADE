// scripts/release-r2-lib.mjs の型（単体テストから読むため）

export type ReleaseOs = 'mac' | 'win' | 'linux'

export interface ReleaseFile {
  name: string
  path: string
  size: number
  sha256: string
  os: ReleaseOs
  arch: string
  kind: string
  preview?: true
}

export interface ReleaseManifest {
  schema: 1
  version: string
  build?: number
  date: string
  prerelease: boolean
  notes: string
  notesUrl?: string
  files: ReleaseFile[]
}

export interface VersionsIndexEntry {
  version: string
  date: string
  prerelease: boolean
  manifest: string
  files: number
}

export interface VersionsIndex {
  schema: 1
  latest: string | null
  versions: VersionsIndexEntry[]
}

export declare const SCHEMA: 1
export declare const KEEP_VERSIONS: number
export declare const IMMUTABLE_CACHE: string
export declare const INDEX_CACHE: string
export declare const MANIFEST_CACHE: string
export declare const STAGING_CACHE: string
export declare const CONTENT_TYPES: Record<string, string>

export declare function parseArtifactName(
  name: string,
  version: string
): { name: string; os: ReleaseOs; arch: string; kind: string } | null
export declare function compareVersionsDesc(a: string, b: string): number
export declare function buildManifest(input: {
  version: string
  date: string
  prerelease: boolean
  notes: string
  notesUrl?: string
  files: Array<{ name: string; os: ReleaseOs; arch: string; kind: string; size: number; sha256: string }>
  previewOs?: string[]
  build?: number
}): ReleaseManifest
export declare function emptyIndex(): VersionsIndex
export declare function addVersionToIndex(
  index: VersionsIndex | null,
  manifest: ReleaseManifest,
  keep?: number
): { index: VersionsIndex; removed: Array<{ version: string; manifest: string }> }
export declare function stagingKey(releasePath: string): string
export declare function replaceVersionInIndex(index: VersionsIndex | null, manifest: ReleaseManifest): VersionsIndex
export declare function obsoleteFiles(oldManifest: ReleaseManifest | null, newManifest: ReleaseManifest): string[]
