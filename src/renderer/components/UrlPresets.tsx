import { useEffect, useState } from 'react'
import { AppWindow, Link2, Pencil, Plus, X } from 'lucide-react'
import type { Project, ProjectTarget } from '@shared/types'
import { defaultUrlLabel, isPresetableUrl, matchPresetUrl, presetTarget } from '@shared/projectUrl'
import { addTarget, hasTargetContent, removeTarget, sanitizeProjectKind, targetAction, updateTarget, urlTargets } from '@shared/projectTargets'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { requestTerminalCommand } from '../lib/terminalCommand'
import { Button, IconButton, Modal, Tooltip, useToast } from '../ui'
import { TargetFields } from './ProjectTargetsEditor'

/**
 * ブラウザのツールバーに並べる、プロジェクトの確認先（ターゲット）のボタン。名前は自由で、件数の上限なし。
 *
 * 押したときの動きは確認先の中身で決まる（src/shared/projectTargets.ts の targetAction）。
 *   - URL … 内蔵ブラウザで開く。表示中の URL に当たるボタンは選択状態になり、
 *           別の環境のボタンを押すと、同じパスのまま環境だけを切り替える。
 *   - ウインドウ … 起動コマンドがあればプロジェクトのターミナルで走らせ、そのウインドウを録画の対象に選ぶ
 *                 （URL もあれば開く。Electron / Tauri の開発サーバーなど）。
 * Orca由来: ~/bench/orca/src/renderer/src/components/browser-pane/ のアドレスバー周りの
 * 「よく開くURLをワンクリックで開く」使い心地（MIT）。履歴・検索・候補は持ち込まない。
 *
 * ツールチップは上向き（真下はネイティブのビュー）。
 * 編集ダイアログを開いている間は、呼び出し側がビューを隠す（onOverlayChange）。
 */
export function UrlPresets({
  project,
  currentUrl,
  onOverlayChange,
  onSelectWindow
}: {
  project: Project | null
  currentUrl: string
  onOverlayChange?: (open: boolean) => void
  /** ウインドウを録画の対象に選ぶ。launched は直前に起動コマンドを走らせたか（ウインドウが出るまで待つ） */
  onSelectWindow?: (windowMatch: string, launched: boolean) => void
}) {
  /** null … 閉じている / isNew … 新規（保存するまで一覧に入れない） */
  const [editing, setEditing] = useState<{ target: ProjectTarget; isNew: boolean } | null>(null)
  const toast = useToast()
  const t = useT()
  const projectId = project?.id ?? null

  // 編集中にプロジェクトが切り替わったら閉じる（ビューを隠したままにしない）
  useEffect(() => {
    setEditing(null)
    onOverlayChange?.(false)
    // onOverlayChange は呼び出し側の setState なので変わらない
  }, [projectId])

  if (!project) return null
  const kind = sanitizeProjectKind(project.kind)
  const selected = matchPresetUrl(project.urls, currentUrl)

  const openEditor = (next: typeof editing) => {
    setEditing(next)
    onOverlayChange?.(next !== null)
  }

  const startAdd = () => {
    // web は表示中の URL をそのまま登録できるようにする。ほかの種類は空から
    const url = kind === 'web' && isPresetableUrl(currentUrl) ? currentUrl : ''
    const target = addTarget(project.urls, kind, url ? { url, label: defaultUrlLabel(url) } : {}).at(-1)!
    openEditor({ target, isNew: true })
  }

  const save = (urls: ProjectTarget[]) => {
    openEditor(null)
    void window.ade
      .invoke('project:update', { id: project.id, urls })
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  const commit = () => {
    if (!editing) return
    const { target, isNew } = editing
    const label = target.label.trim() || (target.url ? defaultUrlLabel(target.url) : '') || target.url || target.windowMatch || target.launchCommand || ''
    const next = { ...target, label }
    save(isNew ? [...project.urls, next] : updateTarget(project.urls, target.id, next))
  }

  const go = (target: ProjectTarget) => {
    const action = targetAction(target, kind)
    if (action.kind === 'none') return openEditor({ target, isNew: false })
    if (action.kind === 'url') {
      void window.ade.invoke('browser:navigate', presetTarget(urlTargets(project.urls), currentUrl, { ...target, url: action.url }))
      return
    }
    let launched = false
    if (action.launchCommand) {
      // ターミナルを開いていなければ、コマンドを知らせるだけにする（勝手に別の場所では走らせない）
      launched = requestTerminalCommand({ command: action.launchCommand, title: target.label })
      toast(launched
        ? { tone: 'info', message: t('projectTargets.launched', { command: action.launchCommand }) }
        : { tone: 'warning', message: t('projectTargets.launchNoTerminal', { command: action.launchCommand }) })
    }
    if (action.url) void window.ade.invoke('browser:navigate', action.url)
    if (action.windowMatch) onSelectWindow?.(action.windowMatch, launched)
  }

  const tooltip = (target: ProjectTarget): string => {
    const action = targetAction(target, kind)
    if (action.kind === 'url') return selected && selected.id !== target.id ? t('urlPresets.samePath', { url: action.url }) : action.url
    if (action.kind === 'window') {
      return [action.url, action.launchCommand && t('projectTargets.tooltipCommand', { command: action.launchCommand }),
        action.windowMatch && t('projectTargets.tooltipWindow', { window: action.windowMatch })].filter(Boolean).join(' · ')
    }
    return target.label
  }

  const draft = editing?.target
  const draftUrl = draft?.url?.trim() ?? ''
  const canSave = !!draft && (draftUrl === '' || isPresetableUrl(draftUrl)) &&
    hasTargetContent({ url: draftUrl, launchCommand: draft.launchCommand?.trim(), windowMatch: draft.windowMatch?.trim() })

  return (
    <div className="url-presets" role="toolbar" aria-label={t('urlPresets.toolbar')} data-testid="url-presets">
      {project.urls.map((target) => {
        const isWindow = targetAction(target, kind).kind === 'window'
        return (
          <Tooltip key={target.id} label={tooltip(target)} side="top">
            <span className={`url-chip${selected?.id === target.id ? ' is-selected' : ''}`}>
              <button
                type="button"
                className="url-chip__main"
                aria-pressed={selected?.id === target.id}
                onClick={() => go(target)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openEditor({ target, isNew: false })
                }}
                data-testid="url-chip"
                data-target-kind={isWindow ? 'window' : 'url'}
              >
                {isWindow && <AppWindow size={11} strokeWidth={1.75} aria-hidden="true" />}
                {target.label}
              </button>
              <button
                type="button"
                className="url-chip__edit"
                aria-label={t('urlPresets.edit', { label: target.label })}
                onClick={() => openEditor({ target, isNew: false })}
              >
                <Pencil size={10} strokeWidth={2} />
              </button>
            </span>
          </Tooltip>
        )
      })}
      <Tooltip label={project.urls.length ? t('urlPresets.addCurrent') : t('urlPresets.addCurrentHint')} side="top">
        <IconButton
          size="sm"
          label={t('urlPresets.add')}
          icon={<Plus size={14} strokeWidth={1.75} />}
          onClick={startAdd}
          data-testid="url-preset-add"
        />
      </Tooltip>

      {editing && draft && (
        <Modal className="rv-modal" label={editing.isNew ? t('urlPresets.add') : t('urlPresets.editTitle')} onClose={() => openEditor(null)}>
          {/* Button は type="button" 固定なので、Enter での確定はここで拾う */}
          <form
            className="rv-modal__panel url-preset-dialog"
            onSubmit={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.target as HTMLElement).tagName === 'INPUT' && canSave) commit()
            }}
          >
            <header className="rv-modal__head url-preset-dialog__head">
              <h2><Link2 size={15} aria-hidden="true" />{editing.isNew ? t('urlPresets.add') : t('urlPresets.editTitle')}</h2>
              <IconButton label={t('common.close')} icon={<X size={16} />} onClick={() => openEditor(null)} />
            </header>
            <p className="url-preset-dialog__project">{project.name}</p>
            <TargetFields autoFocus target={draft} kind={kind} onChange={(patch) => {
              const next = updateTarget([draft], draft.id, patch)[0]!
              // 名前を触っていなければ、URL に合わせて既定の名前を付け直す（web のときだけ）
              if (kind === 'web' && patch.url !== undefined && (draft.label === '' || draft.label === defaultUrlLabel(draft.url ?? ''))) next.label = defaultUrlLabel(patch.url.trim())
              setEditing({ ...editing, target: next })
            }} />
            <div className="url-preset-dialog__actions">
              {!editing.isNew && <Button variant="danger" onClick={() => save(removeTarget(project.urls, draft.id))} data-testid="url-preset-remove">{t('common.delete')}</Button>}
              <span className="url-preset-dialog__spacer" />
              <Button variant="ghost" onClick={() => openEditor(null)}>{t('common.cancel')}</Button>
              <Button variant="primary" disabled={!canSave} onClick={commit} data-testid="url-preset-save">{t('common.save')}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
