// scripts/release-signing.mjs の型（単体テストから読むため）
import type { KeyObject } from 'node:crypto'

export const SIGNING_NAMESPACE: string
export const SIGNER_IDENTITY: string
export const ALLOWED_SIGNERS_PATH: string
export const LOCAL_KEY_PATH: string
export function parseSshEd25519PublicKey(line: string): KeyObject
export function sshPublicKeyLine(publicKey: KeyObject): string
export function signSshsig(message: Buffer | Uint8Array, privateKeyPem: string, namespace?: string): string
export function verifySshsig(message: Buffer | Uint8Array, armored: string, publicKeyLine: string, namespace?: string): boolean
export function trustedPublicKey(allowedSigners: string, identity?: string): string
export function assertSignedSums(sumsBytes: Buffer | Uint8Array, armored: string): void
export function loadSigningKey(keyFile?: string): string
