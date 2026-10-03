/**
 * 画面に出す例外の文。IPC の前置き（Error invoking remote method …）やクラス名を出さず、利用者向けの本文だけにする。
 * E2E の AB-07（API キーの欄に形の違うキーを入れると、IPC の生の文がそのまま出た）の再発防止。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setLocale } from '@shared/i18n'
import { errorMessage } from '../../src/renderer/lib/errors'
import { NO_CIPHER, SttKeyStore } from '../../src/main/pipeline/stt/keys'

describe('errorMessage', () => {
  it('main から届いた IPC の前置きと Error: を外して本文だけにする', () => {
    const ipc = new Error("Error invoking remote method 'capture:apiKey': Error: Invalid API key format. Paste a key starting with sk-.")
    expect(errorMessage(ipc)).toBe('Invalid API key format. Paste a key starting with sk-.')
    expect(errorMessage(new Error("Error invoking remote method 'capture:testConnection': TypeError: fetch failed"))).toBe('fetch failed')
  })

  it('前置きの無い例外・文字列はそのまま（前後の空白だけ落とす）', () => {
    expect(errorMessage(new Error('APIキーの形式が正しくありません。'))).toBe('APIキーの形式が正しくありません。')
    expect(errorMessage(' plain text ')).toBe('plain text')
  })

  it('ターミナルの起動の失敗も本文だけ（node-pty の案内を出す判定に使う語は残る）', () => {
    const err = new Error("Error invoking remote method 'terminal:create': Error: Cannot find module 'node-pty'")
    expect(errorMessage(err)).toBe("Cannot find module 'node-pty'")
    expect(errorMessage(err)).toContain('node-pty')
  })
})

describe('API キーの形の誤りは、利用者向けの例外（不具合として報告しない）', () => {
  it('形の違うキーは UserFacingError で、文面にキーの値を含めない', async () => {
    setLocale('en')
    const dir = await mkdtemp(join(tmpdir(), 'ade-keyerr-'))
    try {
      const store = new SttKeyStore(join(dir, 'k.bin'), NO_CIPHER, {})
      const err = await store.set('openai', 'not-a-valid-secret-value').catch((e: unknown) => e)
      expect(err).toMatchObject({ userFacing: true })
      expect(String((err as Error).message)).not.toContain('not-a-valid-secret-value')
      // 画面に出るのは、IPC で包まれても本文だけ
      expect(errorMessage(new Error(`Error invoking remote method 'capture:apiKey': Error: ${(err as Error).message}`))).toBe((err as Error).message)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
