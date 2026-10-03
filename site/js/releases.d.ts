// releases.js の型。サイトはビルドなしの素の JS なので、単体テスト（tsc）用にだけ置く。

export type Os = 'mac' | 'win' | 'linux'
export type Arch = 'arm64' | 'x64' | 'universal'
export interface AssetInfo { os: Os; arch: Arch; kind: string }
export interface Download { name: string; url: string; size: number; sha256: string; preview: boolean; info: AssetInfo }
export interface Slot { id: string; os: Os; arch: 'arm64' | 'x64'; kinds: string[]; label: string; detail: string; preview: boolean }
export interface Release {
  version: string
  tag: string
  product: string
  date: string
  prerelease: boolean
  notes: string
  notesUrl: string
  assets: Download[]
}
export interface IndexEntry { version: string; tag: string; product: string; date: string; prerelease: boolean; manifestUrl: string }
export interface Platform { os: Os | null; arch: 'arm64' | 'x64' | null; mobile: boolean }
export interface PlatformEnv { userAgent?: string; platform?: string; uaPlatform?: string; uaArch?: string; uaBitness?: string }

export const BUILD_DOC_URL: string
export const CURRENT_PRODUCT: string
export const LEGACY_PRODUCT: string
export const SLOTS: Slot[]
export const VERIFIED_OS: Os[]
export const OS_LABEL: Record<Os, string>

export function classifyAsset(name: string): AssetInfo | null
export const TRUSTED_DOWNLOAD_ORIGINS: string[]
export function joinUrl(base: string, path: unknown, origins?: string[]): string | null
export function notesLink(base: string, url: unknown): string | null
export function normalizeFiles(files: unknown, base: string): Download[]
export function normalizeManifest(manifest: unknown, base: string): Release | null
export function normalizeIndex(index: unknown, base: string): { latest: IndexEntry | null; all: IndexEntry[] }
export function compareVersions(a: string, b: string): number
export function assetForSlot(assets: Download[], slot: Pick<Slot, 'os' | 'arch' | 'kinds'>): Download | null
export function detectPlatform(env?: PlatformEnv): Platform
export function recommendedSlot(platform: Pick<Platform, 'os' | 'arch'> | null): Slot | null
export function formatBytes(bytes: number): string
export function formatDate(iso: string): string
export function excerptNotes(body: string, maxLines?: number): string[]
