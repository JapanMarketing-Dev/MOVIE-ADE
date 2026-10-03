import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { OpenAiSttEngine, openAiSttPricePerMinuteUsd, type OpenAiSttModel } from '../../src/main/pipeline/stt/openai'
import { wavDurationMs } from '../../src/main/pipeline/stt/wav'

const dir = join(process.cwd(), 'e2e-artifacts/openai')
await mkdir(dir, { recursive: true })
const cases = [
  { name: 'ja', language: 'ja', terms: ['申し込み', 'スマホ', '税込', '税抜', '二重'] },
  { name: 'en', language: 'en', terms: ['button', 'pricing', 'mobile', 'submit'] }
]
const models: OpenAiSttModel[] = ['gpt-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1']
const previous = JSON.parse(await readFile(join(dir, 'results.json'), 'utf8').catch(() => '{}')) as { reservedUsd?: number; results?: Array<{ language: string; model: string }> }
let reservedUsd = previous.reservedUsd ?? 0
const results: unknown[] = previous.results ?? []
for (const c of cases) for (const model of models) {
  if (previous.results?.some((result) => result.language === c.language && result.model === model)) continue
  const wavPath = join(dir, `${c.name}.wav`)
  const durationMs = await wavDurationMs(wavPath)
  const cost = durationMs / 60000 * openAiSttPricePerMinuteUsd[model]
  if (reservedUsd + cost > 0.25) throw new Error('検証専用の上限 $0.25 に達しました')
  reservedUsd += cost
  // 試行前に予約額を保存する。再試行なし。秘密情報は保存しない。
  await writeFile(join(dir, 'budget.json'), JSON.stringify({ ceilingUsd: 10, runCeilingUsd: 0.25, reservedUsd, attempts: results.length + 1 }, null, 2))
  try {
    const engine = new OpenAiSttEngine({ model, language: c.language, maxCostUsd: 0.25,
      timeoutMs: 60000, prompt: c.name === 'ja' ? 'UIレビュー。申し込みボタン、スマホ幅、税込、税抜、二重送信。' : 'UI review.' })
    const r = await engine.transcribeChunk({ wavPath, offsetMs: 12000, durationMs, speaker: 'self', source: 'mic' })
    const text = r.segments.map((s) => s.text).join(' ')
    const found = c.terms.filter((t) => text.toLowerCase().includes(t.toLowerCase()))
    const entry = { language: c.language, model, ok: true, text, found, expected: c.terms,
      termRecall: found.length / c.terms.length, elapsedMs: r.elapsedMs, durationMs, estimatedUsd: cost, billedSeconds: r.billedSeconds }
    results.push(entry)
    console.log(JSON.stringify(entry))
  } catch (e) {
    const entry = { language: c.language, model, ok: false, message: String(e).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]'), estimatedReservationUsd: cost }
    results.push(entry); console.log(JSON.stringify(entry))
  }
  await writeFile(join(dir, 'results.json'), JSON.stringify({ reservedUsd, results }, null, 2))
}
console.log(JSON.stringify({ totalEstimatedReservationUsd: reservedUsd, accountInvoiceVerified: false }))
