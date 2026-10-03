import type { AiVendor } from '@shared/aiProviders'

/**
 * キーの欄の下に「この環境変数も使えます」と出す名前（提供元ごと）。実際に読まれる名前だけを返す。
 *   - 設定に apiKeyEnv を書いていれば、その名前（settings.json → 環境変数・.env から読む。src/main/settingsKeys.ts）
 *   - dev 起動の OpenAI だけは、鍵の保存先が OPENAI_API_KEY を読む（src/main/pipeline/stt/keys.ts）
 *   - どちらでもなければ出さない（読まれない名前を案内しない）
 */
export function keyEnvHint(vendor: AiVendor, configuredEnv: string | null | undefined, storage: 'encrypted' | 'session' | 'dev'): string | null {
  const configured = configuredEnv?.trim()
  if (configured) return configured
  if (storage === 'dev' && vendor === 'openai') return 'OPENAI_API_KEY'
  return null
}
