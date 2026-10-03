import { describe, expect, it } from 'vitest'
import { keyEnvHint } from '../../src/renderer/lib/keyEnvHint'

describe('キーの欄の「この環境変数も使えます」（提供元ごとの名前）', () => {
  it('設定に apiKeyEnv があれば、その名前を出す（Cloudflare なら CLOUDFLARE_API_TOKEN）', () => {
    expect(keyEnvHint('cloudflare', 'CLOUDFLARE_API_TOKEN', 'encrypted')).toBe('CLOUDFLARE_API_TOKEN')
    expect(keyEnvHint('groq', ' GROQ_API_KEY ', 'dev')).toBe('GROQ_API_KEY')
    expect(keyEnvHint('vercel-gateway', 'AI_GATEWAY_API_KEY', 'session')).toBe('AI_GATEWAY_API_KEY')
  })

  it('OpenAI 以外では、apiKeyEnv が無ければ OPENAI_API_KEY を出さない（読まれない名前を案内しない）', () => {
    expect(keyEnvHint('cloudflare', undefined, 'dev')).toBeNull()
    expect(keyEnvHint('anthropic', '', 'dev')).toBeNull()
    expect(keyEnvHint('decision-custom', null, 'encrypted')).toBeNull()
  })

  it('dev 起動の OpenAI だけは、鍵の保存先が読む OPENAI_API_KEY を出す', () => {
    expect(keyEnvHint('openai', undefined, 'dev')).toBe('OPENAI_API_KEY')
    expect(keyEnvHint('openai', undefined, 'encrypted')).toBeNull()
  })
})
