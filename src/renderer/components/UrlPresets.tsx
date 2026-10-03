import { useEffect, useState } from 'react'
import { Globe, Link2, Pencil, Plus, X } from 'lucide-react'
import type { Project, ProjectUrl } from '@shared/types'
import { defaultUrlLabel, isPresetableUrl, matchPresetUrl, presetTarget } from '@shared/projectUrl'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Button, Field, IconButton, Modal, Tooltip, useToast } from '../ui'

/**
 * ブラウザのツールバーに並べる、プロジェクトのURLプリセット（local / dev / prd）。
 *
 * 押すとすぐ開く。表示中のURLに当たるチップは選択状態になり、
 * 別の環境のチップを押すと、同じパスのまま環境だけを切り替える。
 * Orca由来: ~/bench/orca/src/renderer/src/components/browser-pane/ のアドレスバー周りの
 * 「よく開くURLをワンクリックで開く」使い心地（MIT）。履歴・検索・候補は持ち込まない。
 *
 * ツールチップは上向き（真下はネイティブのビュー）。
 * 編集ダイアログを開いている間は、呼び出し側がビューを隠す（onOverlayChange）。
 */
export function UrlPresets({
  project,
  currentUrl,
  onOverlayChange
}: {
  project: Project | null
  currentUrl: string
  onOverlayChange?: (open: boolean) => void
}) {
  /** null … 閉じている / id なし … 新規 / id あり … 編集 */
  const [editing, setEditing] = useState<{ id: string | null; label: string; url: string } | null>(null)
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
  const selected = matchPresetUrl(project.urls, currentUrl)

  const openEditor = (next: typeof editing) => {
    setEditing(next)
    onOverlayChange?.(next !== null)
  }

  const startAdd = () => {
    const url = isPresetableUrl(currentUrl) ? currentUrl : ''
    openEditor({ id: null, label: url ? defaultUrlLabel(url) : '', url })
  }

  const save = (urls: ProjectUrl[]) => {
    openEditor(null)
    void window.ade
      .invoke('project:update', { ...project, urls })
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  const commit = () => {
    if (!editing) return
    const url = editing.url.trim()
    const label = editing.label.trim() || defaultUrlLabel(url) || url
    if (editing.id) save(project.urls.map((u) => (u.id === editing.id ? { ...u, label, url } : u)))
    else save([...project.urls, { id: crypto.randomUUID(), label, url }])
  }

  const remove = () => {
    if (!editing?.id) return
    save(project.urls.filter((u) => u.id !== editing.id))
  }

  const go = (preset: ProjectUrl) => {
    void window.ade.invoke('browser:navigate', presetTarget(project.urls, currentUrl, preset))
  }

  const urlValid = editing ? isPresetableUrl(editing.url.trim()) : false

  return (
    <div className="url-presets" role="toolbar" aria-label={t('urlPresets.toolbar')} data-testid="url-presets">
      {project.urls.map((preset) => (
        <Tooltip key={preset.id} label={selected && selected.id !== preset.id ? t('urlPresets.samePath', { url: preset.url }) : preset.url} side="top">
          <span className={`url-chip${selected?.id === preset.id ? ' is-selected' : ''}`}>
            <button
              type="button"
              className="url-chip__main"
              aria-pressed={selected?.id === preset.id}
              onClick={() => go(preset)}
              onContextMenu={(e) => {
                e.preventDefault()
                openEditor({ id: preset.id, label: preset.label, url: preset.url })
              }}
              data-testid="url-chip"
            >
              {preset.label}
            </button>
            <button
              type="button"
              className="url-chip__edit"
              aria-label={t('urlPresets.edit', { label: preset.label })}
              onClick={() => openEditor({ id: preset.id, label: preset.label, url: preset.url })}
            >
              <Pencil size={10} strokeWidth={2} />
            </button>
          </span>
        </Tooltip>
      ))}
      <Tooltip label={project.urls.length ? t('urlPresets.addCurrent') : t('urlPresets.addCurrentHint')} side="top">
        <IconButton
          size="sm"
          label={t('urlPresets.add')}
          icon={<Plus size={14} strokeWidth={1.75} />}
          onClick={startAdd}
          data-testid="url-preset-add"
        />
      </Tooltip>

      {editing && (
        <Modal className="rv-modal" label={editing.id ? t('urlPresets.editTitle') : t('urlPresets.add')} onClose={() => openEditor(null)}>
          {/* Button は type="button" 固定なので、Enter での確定はここで拾う */}
          <form
            className="rv-modal__panel url-preset-dialog"
            onSubmit={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.target as HTMLElement).tagName === 'INPUT' && urlValid) commit()
            }}
          >
            <header className="rv-modal__head url-preset-dialog__head">
              <h2><Link2 size={15} aria-hidden="true" />{editing.id ? t('urlPresets.editTitle') : t('urlPresets.add')}</h2>
              <IconButton label={t('common.close')} icon={<X size={16} />} onClick={() => openEditor(null)} />
            </header>
            <p className="url-preset-dialog__project">{project.name}</p>
            <label className="url-preset-dialog__field">
              <span>{t('urlPresets.name')}</span>
              <Field
                autoFocus
                placeholder="local / dev / prd"
                value={editing.label}
                onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                data-testid="url-preset-label"
              />
            </label>
            <label className="url-preset-dialog__field">
              <span>URL</span>
              <Field
                mono
                icon={<Globe size={14} strokeWidth={1.75} />}
                placeholder="http://localhost:3000"
                value={editing.url}
                invalid={editing.url.trim() !== '' && !urlValid}
                onChange={(e) => {
                  const url = e.target.value
                  // 名前を触っていなければ、URLに合わせて既定の名前を付け直す
                  const auto = editing.label === '' || editing.label === defaultUrlLabel(editing.url)
                  setEditing({ ...editing, url, label: auto ? defaultUrlLabel(url.trim()) : editing.label })
                }}
                data-testid="url-preset-url"
              />
            </label>
            {editing.url.trim() !== '' && !urlValid && <p className="st-note st-note--warn">{t('urlPresets.invalid')}</p>}
            <div className="url-preset-dialog__actions">
              {editing.id && <Button variant="danger" onClick={remove} data-testid="url-preset-remove">{t('common.delete')}</Button>}
              <span className="url-preset-dialog__spacer" />
              <Button variant="ghost" onClick={() => openEditor(null)}>{t('common.cancel')}</Button>
              <Button variant="primary" disabled={!urlValid} onClick={commit} data-testid="url-preset-save">{t('common.save')}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
