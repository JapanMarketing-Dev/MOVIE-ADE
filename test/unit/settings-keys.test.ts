import { describe, expect, it } from 'vitest'
import { keepKeyRefs, redactKeys, resolveApiKey, resolveConfiguredKey } from '../../src/main/settingsKeys'

/** settings.json から指定するキーの優先順（src/main/settingsKeys.ts）。ファイルは読まず、読み込みを差し替える */

const files: Record<string, string> = {
  '/proj/.env': 'PROJECT_ONLY=from-project\nSHARED=project-wins\n',
  '/cfg/.env': 'CONFIG_ONLY=from-config\nSHARED=config-loses\n'
}
const readText = (path: string): string => {
  const text = files[path.replace(/\\/g, '/')]
  if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  return text
}
const lookup = { env: { FROM_ENV: 'from-env', SHARED: 'env-wins' } as NodeJS.ProcessEnv, projectDir: '/proj', configDir: '/cfg', readText }

describe('resolveConfiguredKey', () => {
  it('平文の apiKey が最優先', () => {
    expect(resolveConfiguredKey({ apiKey: 'plain', apiKeyEnv: 'FROM_ENV' }, lookup)).toEqual({ key: 'plain', source: 'config' })
  })

  it('apiKeyEnv は 環境変数 → プロジェクトの .env → 設定フォルダの .env', () => {
    expect(resolveConfiguredKey({ apiKeyEnv: 'SHARED' }, lookup)?.key).toBe('env-wins')
    expect(resolveConfiguredKey({ apiKeyEnv: 'PROJECT_ONLY' }, lookup)?.key).toBe('from-project')
    expect(resolveConfiguredKey({ apiKeyEnv: 'CONFIG_ONLY' }, lookup)).toEqual({ key: 'from-config', source: 'configEnv' })
    expect(resolveConfiguredKey({ apiKeyEnv: 'MISSING' }, lookup)).toBeNull()
  })

  it('指定が無ければ環境変数を勝手に読まない', () => {
    expect(resolveConfiguredKey(undefined, { ...lookup, env: { OPENAI_API_KEY: 'sk-dev' } })).toBeNull()
    expect(resolveConfiguredKey({}, lookup)).toBeNull()
  })
})

describe('resolveApiKey', () => {
  it('settings.json の指定 > 保存したキー。指定があれば保存したキーを復号しない', async () => {
    let decrypted = 0
    const saved = async () => { decrypted++; return 'saved-key' }
    expect(await resolveApiKey({ apiKey: 'plain' }, lookup, saved)).toBe('plain')
    expect(await resolveApiKey({ apiKeyEnv: 'FROM_ENV' }, lookup, saved)).toBe('from-env')
    expect(decrypted).toBe(0)
    expect(await resolveApiKey({ apiKeyEnv: 'MISSING' }, lookup, saved)).toBe('saved-key')
    expect(await resolveApiKey(undefined, lookup, saved)).toBe('saved-key')
  })
})

describe('redactKeys / keepKeyRefs', () => {
  it('renderer へ渡す前に apiKey を外す（apiKeyEnv は名前だけなので残す）', () => {
    const out = redactKeys({ capture: { sttEndpoints: { openai: { apiKey: 'sk-secret', apiKeyEnv: 'X', model: 'm' } } }, list: [{ apiKey: 'a' }] })
    expect(JSON.stringify(out)).not.toContain('sk-secret')
    expect(out.capture.sttEndpoints.openai).toEqual({ apiKeyEnv: 'X', model: 'm' })
    expect(out.list).toEqual([{}])
  })

  it('画面からの保存で settings.json のキーの指定を消さない。apiKeyEnv を空で送れば消せる', () => {
    const prev: Record<string, { apiKey?: string; apiKeyEnv?: string; model?: string }> = { openai: { apiKey: 'sk-file', apiKeyEnv: 'OPENAI_API_KEY', model: 'old' } }
    expect(keepKeyRefs(prev, { openai: { model: 'new' } })).toEqual({ openai: { model: 'new', apiKey: 'sk-file', apiKeyEnv: 'OPENAI_API_KEY' } })
    expect(keepKeyRefs(prev, { openai: { model: 'new', apiKeyEnv: '' } })).toEqual({ openai: { model: 'new', apiKeyEnv: '', apiKey: 'sk-file' } })
    // 画面で接続先を既定に戻しても（項目が無い）キーの指定は残る
    expect(keepKeyRefs(prev, {})).toEqual({ openai: { apiKey: 'sk-file', apiKeyEnv: 'OPENAI_API_KEY' } })
  })
})

describe('任意の接続先（認証の形・環境変数のヘッダー・Cloudflare のアカウント）', () => {
  it('authHeaders: 既定はプリセットの形、bearer / header / none で上書きできる', async () => {
    const { authHeaders } = await import('@shared/aiProviders')
    const fallback = { 'x-api-key': 'k' }
    expect(authHeaders(undefined, 'k', fallback)).toEqual(fallback)
    expect(authHeaders({ authScheme: 'bearer' }, 'k', fallback)).toEqual({ Authorization: 'Bearer k' })
    expect(authHeaders({ authScheme: 'header', authHeader: 'api-key' }, 'k', fallback)).toEqual({ 'api-key': 'k' })
    expect(authHeaders({ authScheme: 'none' }, 'k', fallback)).toEqual({})
    expect(authHeaders(undefined, undefined, fallback)).toEqual({})
  })

  it('resolveEndpointRefs: {account_id} とヘッダーの { env } を解決する', async () => {
    const { resolveEndpointRefs } = await import('../../src/main/settingsKeys')
    const env = { CLOUDFLARE_ACCOUNT_ID: 'acc123', GATEWAY_TOKEN: 'gw-secret' } as NodeJS.ProcessEnv
    const out = resolveEndpointRefs({ baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1', model: '@cf/openai/whisper',
      headers: { 'X-Team': 'ui', 'cf-aig-authorization': { env: 'GATEWAY_TOKEN' }, 'X-Missing': { env: 'NOPE' } } }, { ...lookup, env })
    expect(out).toEqual({ baseUrl: 'https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1', model: '@cf/openai/whisper',
      headers: { 'X-Team': 'ui', 'cf-aig-authorization': 'gw-secret' } })
    // accountId を書けば環境変数より優先
    expect(resolveEndpointRefs({ baseUrl: 'https://x/{account_id}', accountId: 'mine' }, { ...lookup, env })?.baseUrl).toBe('https://x/mine')
  })

  it('sanitizeEndpointConfig: 新しい項目を保ち、壊れた値は捨てる', async () => {
    const { sanitizeEndpointConfig } = await import('../../src/main/pipeline/stt/endpoint')
    expect(sanitizeEndpointConfig({ baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1', authScheme: 'header', authHeader: 'x-api-key',
      accountId: 'abc', headers: { Authorization: 'Bearer leaked', 'cf-aig-authorization': { env: 'CF_AIG_TOKEN' }, 'X-Team': 'ui', 'X-Bad': { env: 'not an env' } } }))
      .toEqual({ baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1', authScheme: 'header', authHeader: 'x-api-key', accountId: 'abc',
        headers: { 'cf-aig-authorization': { env: 'CF_AIG_TOKEN' }, 'X-Team': 'ui' } })
    // 開発中だけあった headersEnv は { env } へ移す
    expect(sanitizeEndpointConfig({ headersEnv: { Authorization: 'MY_TOKEN' } })).toEqual({ headers: { Authorization: { env: 'MY_TOKEN' } } })
    expect(sanitizeEndpointConfig({ authScheme: 'basic' })).toBeUndefined()
  })
})

describe('ヘッダーの行（画面）', () => {
  it('${VAR} は { env } になり、書き戻すと同じ行になる', async () => {
    const { parseHeaderLines, formatHeaderLines } = await import('@shared/aiProviders')
    const headers = parseHeaderLines('HTTP-Referer: https://example.com\nAuthorization: ${MY_TOKEN}\nbroken line')
    expect(headers).toEqual({ 'HTTP-Referer': 'https://example.com', Authorization: { env: 'MY_TOKEN' } })
    expect(formatHeaderLines(headers)).toBe('HTTP-Referer: https://example.com\nAuthorization: ${MY_TOKEN}')
  })
})
