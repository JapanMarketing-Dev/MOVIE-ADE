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
  product?: string
  build?: number
  date: string
  prerelease: boolean
  notes: string
  notesUrl?: string
  files: ReleaseFile[]
}

export interface VersionsIndexEntry {
  version: string
  product?: string
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
export declare const PRODUCTS: string[]
export declare const KEEP_VERSIONS: number
export declare const IMMUTABLE_CACHE: string
export declare const INDEX_CACHE: string
export declare const MANIFEST_CACHE: string
export declare const STAGING_CACHE: string
export declare const CONTENT_TYPES: Record<string, string>

export declare function parseArtifactName(
  name: string,
  version: string
): { name: string; product: string; os: ReleaseOs; arch: string; kind: string } | null
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
  product?: string
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

export declare const PUT_LIMIT_BYTES: number
export declare function isValidVersion(version: unknown): version is string
export declare function assertValidVersion(version: unknown): string
export declare function releaseDir(version: string, build?: number): string
export declare function validateManifest(manifest: unknown, version: string): ReleaseManifest
/** 公開済みの manifest のリリースノートだけを差し替える（形を確かめて返す） */
export declare function withNotes(manifest: ReleaseManifest, notes: string): ReleaseManifest
export declare function validateIndex(index: unknown): VersionsIndex
export declare function parseSha256Sums(text: string): Map<string, string>
export declare function formatSha256Sums(files: Array<{ name: string; sha256: string }>): string
export declare function assertManifestMatchesSums(manifest: { files: Array<{ name: string; sha256: string }> }, sums: Map<string, string>): void
export declare function workPath(
  work: string,
  name: string,
  path: { resolve: (...p: string[]) => string; relative: (a: string, b: string) => string; isAbsolute: (p: string) => boolean; sep: string }
): string
export declare function isExactPackageSpec(spec: string): boolean
export declare function ghReleaseCreateArgs(input: {
  version: string
  repo: string
  sumsFile: string
  notes: string
  target?: string
  prerelease?: boolean
  product?: string
}): string[]
export declare function ghReleasePublishArgs(input: { version: string; repo: string }): string[]
export declare function ghReleaseNotes(version: string, downloadUrl?: string): string
