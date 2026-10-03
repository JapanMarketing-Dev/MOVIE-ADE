/**
 * Sentry のアラート（ferret）を作る・直す。何度流しても同じ状態になる（名前で見分ける）。
 *
 *   SENTRY_AUTH_TOKEN=<alerts:write を持つトークン> node scripts/sentry-alerts.mjs [--dry-run]
 *
 * 作るもの（どれも environment=production だけ。dev / verification では鳴らない）:
 *   1. 新しい issue・再発（regression）・急増（1時間に20件）でメール（issue の担当＝プロジェクトのチーム。居なければメンバー全員）
 *   2. プロジェクトの既定の「優先度の高い issue」のアラートを production だけにする（dev の騒がしさを止める）
 *   3. クラッシュしなかったセッションの割合が 99% を下回ったらチームへメール（1時間ごと）
 *
 * sentry CLI のログイン（OAuth）には alerts:write が無いので、Sentry の Personal Token
 * （Settings → Account → Personal Tokens → Create New Token、scopes: alerts:read, alerts:write, project:read, org:read）を
 * SENTRY_AUTH_TOKEN で渡す。トークンは表示しない。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const org = process.env.SENTRY_ORG || 'workspacepm'
const project = process.env.SENTRY_PROJECT || 'ferret'
const dryRun = process.argv.includes('--dry-run')
const WORKFLOW_NAME = 'Ferret production: new issue / regression / spike'
const METRIC_NAME = 'Ferret production: crash-free sessions < 99%'
const dir = mkdtempSync(join(tmpdir(), 'sentry-alerts-'))

function api(path, { method = 'GET', body } = {}) {
  const args = ['api', path, '--json']
  if (method !== 'GET') args.push('-X', method)
  if (body !== undefined) {
    const file = join(dir, 'body.json')
    writeFileSync(file, JSON.stringify(body))
    args.push('--input', file)
  }
  if (dryRun && method !== 'GET') {
    console.log(`[dry-run] ${method} ${path}`)
    return null
  }
  const r = spawnSync('sentry', args, { encoding: 'utf8' })
  const text = r.stdout?.trim() ?? ''
  const data = text ? JSON.parse(text) : null
  if (r.status !== 0 || (data && typeof data === 'object' && 'detail' in data && Object.keys(data).length === 1)) {
    throw new Error(`${method} ${path}: ${data?.detail ?? r.stderr?.trim() ?? 'failed'}`)
  }
  return data
}

try {
  const proj = api(`projects/${org}/${project}/`)
  const team = proj.teams?.[0]
  const detectors = api(`organizations/${org}/detectors/?project=${proj.id}`)
  const stream = detectors.find((d) => d.type === 'issue_stream' && String(d.projectId) === String(proj.id))
  if (!stream) throw new Error('プロジェクトの issue stream の monitor が見つかりません')
  const workflows = api(`organizations/${org}/workflows/`)

  // 1. 新しい issue・再発・急増
  const email = { type: 'email', integrationId: null, data: { fallthroughType: 'ActiveMembers' }, config: { targetType: 'issue_owners', targetIdentifier: null } }
  const wanted = {
    name: WORKFLOW_NAME,
    enabled: true,
    environment: 'production',
    detectorIds: [String(stream.id)],
    config: { frequency: 30 },
    triggers: {
      logicType: 'any-short',
      conditions: [
        { type: 'first_seen_event', comparison: true, conditionResult: true },
        { type: 'regression_event', comparison: true, conditionResult: true },
        { type: 'event_frequency_count', comparison: { interval: '1h', value: 20 }, conditionResult: true }
      ],
      actions: []
    },
    actionFilters: [{ logicType: 'any-short', conditions: [], actions: [email] }]
  }
  const existing = workflows.find((w) => w.name === WORKFLOW_NAME)
  if (existing) api(`organizations/${org}/workflows/${existing.id}/`, { method: 'PUT', body: { ...wanted, id: existing.id } })
  else api(`organizations/${org}/workflows/`, { method: 'POST', body: wanted })
  console.log(`${existing ? '更新' : '作成'}: ${WORKFLOW_NAME}`)

  // 2. 既定の「優先度の高い issue」のアラートを production だけに
  for (const w of workflows.filter((x) => x.detectorIds?.includes(String(stream.id)) && x.name !== WORKFLOW_NAME && x.environment !== 'production')) {
    api(`organizations/${org}/workflows/${w.id}/`, { method: 'PUT', body: { ...w, environment: 'production' } })
    console.log(`production だけに: ${w.name}（${w.id}）`)
  }

  // 3. クラッシュしなかったセッションの割合
  let rules = []
  try {
    rules = api(`organizations/${org}/alert-rules/?project=${proj.id}`) ?? []
  } catch {
    // 一覧を読めない（権限・古い API）ときは、作るほうで判断する
  }
  if (!rules.some((r) => r.name === METRIC_NAME)) {
    api(`organizations/${org}/alert-rules/`, {
      method: 'POST',
      body: {
        name: METRIC_NAME,
        projects: [project],
        environment: 'production',
        dataset: 'metrics',
        queryType: 2,
        query: '',
        aggregate: 'percentage(sessions_crashed, sessions) AS _crash_rate_alert_aggregate',
        timeWindow: 60,
        thresholdType: 1,
        resolveThreshold: 99.5,
        triggers: [{ label: 'critical', alertThreshold: 99, actions: team ? [{ type: 'email', targetType: 'team', targetIdentifier: String(team.id) }] : [] }]
      }
    })
    console.log(`作成: ${METRIC_NAME}`)
  }
} catch (err) {
  console.error(`[sentry-alerts] ${err instanceof Error ? err.message : String(err)}`)
  console.error('alerts:write を持つトークンを SENTRY_AUTH_TOKEN で渡してください（ファイルの先頭のコメントを参照）')
  process.exitCode = 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
