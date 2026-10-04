// verify.js の型（単体テストから使う）
export const RELEASE_PUBLIC_KEY: string
export const RELEASE_SIGNING_NAMESPACE: string
export const RELEASE_PRODUCT: string
export const MAX_INSTALLER_BYTES: number

export interface SignedArtifactInfo {
  os: 'mac' | 'win' | 'linux'
  arch: 'arm64' | 'x64'
  kind: 'dmg' | 'exe' | 'AppImage' | 'deb'
}

export function verifySshSignature(message: Uint8Array, armored: string, trustedKey?: string, namespace?: string): Promise<boolean>
export function parseSignedSums(sumsText: string): Map<string, string> | null
export function parseSignedArtifactName(name: string, version: string): SignedArtifactInfo | null
export function verifiedAssets<A extends { name: string; url: string; size: number; sha256: string }>(
  release: { version: string; assets: A[] },
  base: string,
  sums: Uint8Array,
  signature: string,
  trustedKey?: string
): Promise<Array<A & { info: SignedArtifactInfo }> | null>
export function verifyRelease<R extends { version: string; assets: unknown[] }>(
  release: R,
  base: string,
  fetcher?: typeof fetch
): Promise<R & { verified: boolean }>
export function fetchVerifiedBytes(
  asset: { url: string; size: number; sha256: string },
  onProgress?: (fraction: number) => void,
  fetcher?: typeof fetch
): Promise<Blob>
