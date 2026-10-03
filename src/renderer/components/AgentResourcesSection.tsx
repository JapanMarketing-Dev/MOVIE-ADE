import { useCallback, useMemo, useState } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import type { AgentResourceItem, AgentResourceKind, AgentResourceList } from '@shared/agentResources'
import type { TuiAgent } from '@shared/types'
import { Field } from '../ui'
import { useT, type TFunction } from '../lib/i18n'
import { errorMessage } from '../lib/errors'
import { AgentIcon } from './AgentIcon'
import '../styles/agentResources.css'

/**
 * 設定の Agents の節：有効な Agent CLI ごとの「スキル・スラッシュコマンド・MCP サーバー」の一覧。
 *
 * - CLI ごとに折りたたみ、開いたときに初めて読む（再読み込みのボタン付き）
 * - 名前で絞り込める
 * - 読むだけ。MCP サーバーは名前・種類・コマンド名か URL の host だけ（main で絞った値しか届かない）
 */

const KIND_ORDER: readonly AgentResourceKind[] = ['skill', 'command', 'mcp']

function kindLabel(t: TFunction, agent: TuiAgent, kind: AgentResourceKind): string {
  if (kind === 'skill') return t('settings.agentResources.kind.skill')
  if (kind === 'mcp') return t('settings.agentResources.kind.mcp')
  // Codex はスラッシュコマンドではなく「プロンプト」と呼ぶ
  return agent === 'codex' ? t('settings.agentResources.kind.prompt') : t('settings.agentResources.kind.command')
}

function sourceLabel(t: TFunction, item: AgentResourceItem): string {
  if (item.source.type === 'plugin') return t('settings.agentResources.source.plugin', { name: item.source.plugin })
  return item.source.type === 'project' ? t('settings.agentResources.source.project') : t('settings.agentResources.source.user')
}

function ResourceRow({ item, t }: { item: AgentResourceItem; t: TFunction }) {
  const name = item.kind === 'command' ? `/${item.name}` : item.name
  const detail = item.kind === 'mcp' ? [item.transport, item.target].filter(Boolean).join(' · ') : item.description
  return (
    <li className="agent-res__row">
      <span className="agent-res__head">
        <span className="agent-res__name" title={name}>{name}</span>
        <span className="agent-res__source">{sourceLabel(t, item)}</span>
      </span>
      {detail && <span className="agent-res__detail" title={detail}>{detail}</span>}
    </li>
  )
}

type LoadState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; list: AgentResourceList }

function AgentResources({ agent, label }: { agent: TuiAgent; label: string }) {
  const t = useT()
  const [state, setState] = useState<LoadState>({ kind: 'idle' })
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      setState({ kind: 'ok', list: await window.ade.invoke('agents:resources', agent) })
    } catch (err) {
      setState({ kind: 'error', message: errorMessage(err) })
    }
  }, [agent])

  const list = state.kind === 'ok' ? state.list : null
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const items = list?.items ?? []
    return needle ? items.filter((item) => item.name.toLowerCase().includes(needle)) : items
  }, [list, query])
  const count = (kind: AgentResourceKind) => list?.items.filter((item) => item.kind === kind).length ?? 0

  return (
    <details
      className="agent-res"
      data-testid={`agent-resources-${agent}`}
      // 開いたときだけ読む（まだ読んでいなければ）
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open && state.kind === 'idle') void load()
      }}
    >
      <summary className="agent-res__summary">
        <AgentIcon agent={agent} label={label} size={14} />
        <span className="agent-res__title">{label}</span>
        {list && (
          <span className="agent-res__count">
            {list.supported
              ? t('settings.agentResources.summary', { skills: count('skill'), commands: count('command'), mcp: count('mcp') })
              : t('settings.agentResources.unsupported')}
          </span>
        )}
      </summary>
      <div className="agent-res__body">
        <div className="agent-res__tools">
          <Field
            icon={<Search size={13} aria-hidden="true" />}
            className="agent-res__filter"
            placeholder={t('settings.agentResources.filter')}
            aria-label={t('settings.agentResources.filter')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={!list?.supported}
          />
          <button type="button" className="agent-res__reload" onClick={() => void load()} disabled={state.kind === 'loading'} title={t('settings.agentResources.reload')} aria-label={t('settings.agentResources.reload')}>
            <RefreshCw size={13} className={state.kind === 'loading' ? 'is-spinning' : ''} aria-hidden="true" />
          </button>
        </div>
        {state.kind === 'loading' && <p className="st-note">{t('settings.agentResources.loading')}</p>}
        {state.kind === 'error' && <p className="st-note st-note--warn" role="alert">{t('settings.agentResources.error')} {state.message}</p>}
        {list && !list.supported && <p className="st-note">{t('settings.agentResources.unsupported')}</p>}
        {list?.supported && list.items.length === 0 && <p className="st-note">{t('settings.agentResources.empty')}</p>}
        {list?.supported && list.items.length > 0 && filtered.length === 0 && <p className="st-note">{t('settings.agentResources.noMatch')}</p>}
        {list?.supported &&
          KIND_ORDER.map((kind) => {
            const items = filtered.filter((item) => item.kind === kind)
            if (items.length === 0) return null
            return (
              <section key={kind} className="agent-res__group">
                <h4 className="agent-res__kind">
                  {kindLabel(t, agent, kind)} <span className="agent-res__kind-count">{items.length}</span>
                </h4>
                <ul className="agent-res__list">
                  {items.map((item, index) => <ResourceRow key={`${item.source.type}:${item.name}:${index}`} item={item} t={t} />)}
                </ul>
              </section>
            )
          })}
        {list?.warnings.map((warning, index) => (
          <p key={index} className="st-note st-note--warn">
            {t(`settings.agentResources.warning.${warning.code}`, {
              file: warning.code === 'truncated' ? kindLabel(t, agent, warning.file as AgentResourceKind) : warning.file
            })}
          </p>
        ))}
      </div>
    </details>
  )
}

/** agents は「インストール済みで有効」なものだけを渡す */
export function AgentResourcesSection({ agents }: { agents: Array<{ id: TuiAgent; label: string }> }) {
  const t = useT()
  return (
    <div className="agent-res-section" data-testid="agent-resources">
      <h3 className="st-page__subheading">{t('settings.agentResources.title')}</h3>
      <p className="st-note">{t('settings.agentResources.intro')}</p>
      {agents.length === 0 ? (
        <p className="st-note">{t('settings.agentResources.noAgents')}</p>
      ) : (
        agents.map((agent) => <AgentResources key={agent.id} agent={agent.id} label={agent.label} />)
      )}
    </div>
  )
}
