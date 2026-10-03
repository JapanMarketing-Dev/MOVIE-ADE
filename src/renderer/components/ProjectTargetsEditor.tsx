import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react'
import type { Project, ProjectKind, ProjectTarget } from '@shared/types'
import { isPresetableUrl } from '@shared/projectUrl'
import {
  KIND_FIELDS,
  KIND_PLACEHOLDERS,
  PROJECT_KINDS,
  SUGGESTED_LABELS,
  addTarget,
  hasTargetContent,
  moveTarget,
  removeTarget,
  sanitizeProjectKind,
  updateTarget
} from '@shared/projectTargets'
import type { TranslationKey } from '@shared/i18n'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Button, Field, IconButton, Modal, Segmented, useToast } from '../ui'

/**
 * プロジェクトの種類（web / mobile / desktop / other）と、確認先（ターゲット）の一覧の編集。
 * 確認先は名前が自由で件数の上限なし。追加・削除・名前の変更・並べ替えができる。
 * 種類によって出す欄が変わる（web は URL だけ、ほかは起動コマンドと録画するウインドウも）。
 *
 * オンボーディングの「プロジェクト」の手順と、サイドバーの「プロジェクトを編集」で同じものを使う。
 * 変えたら少し待って project:update で保存する（空の確認先は main の sanitize が落とすが、画面では残す）。
 */
const SAVE_DELAY_MS = 400

/** 1件分の欄。ツールバーのチップの編集ダイアログでも使う */
export function TargetFields({ target, kind, onChange, autoFocus }: {
  target: ProjectTarget
  kind: ProjectKind
  onChange: (patch: Partial<Omit<ProjectTarget, 'id'>>) => void
  autoFocus?: boolean
}) {
  const t = useT()
  const fields = KIND_FIELDS[kind]
  const placeholder = KIND_PLACEHOLDERS[kind]
  const url = target.url ?? ''
  const urlInvalid = url.trim() !== '' && !isPresetableUrl(url.trim())
  return <div className="pt-fields">
    <label className="pt-field">
      <span>{t('projectTargets.label')}</span>
      <Field autoFocus={autoFocus} placeholder={SUGGESTED_LABELS[kind].join(' / ')} value={target.label}
        onChange={(e) => onChange({ label: e.target.value })} data-testid="target-label" />
    </label>
    {fields.url && <label className="pt-field">
      <span>URL</span>
      <Field mono placeholder={placeholder.url} value={url} invalid={urlInvalid} autoComplete="off" spellCheck={false}
        onChange={(e) => onChange({ url: e.target.value })} data-testid="target-url" />
    </label>}
    {fields.launchCommand && <label className="pt-field">
      <span>{t('projectTargets.launchCommand')}</span>
      <Field mono placeholder={placeholder.launchCommand} value={target.launchCommand ?? ''} autoComplete="off" spellCheck={false}
        onChange={(e) => onChange({ launchCommand: e.target.value })} data-testid="target-command" />
    </label>}
    {fields.windowMatch && <label className="pt-field">
      <span>{t('projectTargets.windowMatch')}</span>
      <Field placeholder={placeholder.windowMatch} value={target.windowMatch ?? ''} autoComplete="off" spellCheck={false}
        onChange={(e) => onChange({ windowMatch: e.target.value })} data-testid="target-window" />
    </label>}
    {urlInvalid && <p className="st-note st-note--warn">{t('urlPresets.invalid')}</p>}
    {!hasTargetContent({ url: url.trim(), launchCommand: target.launchCommand?.trim(), windowMatch: target.windowMatch?.trim() }) &&
      <p className="st-note" data-testid="target-incomplete">{t(fields.launchCommand ? 'projectTargets.incomplete' : 'projectTargets.incompleteWeb')}</p>}
  </div>
}

export function ProjectTargetsEditor({ project }: { project: Project }) {
  const t = useT()
  const toast = useToast()
  // 編集中の値は手元に持つ（保存のたびに main から届く値で書きかけが消えないように）。別のプロジェクトになったら読み直す
  const [kind, setKind] = useState<ProjectKind>(sanitizeProjectKind(project.kind))
  const [targets, setTargets] = useState<ProjectTarget[]>(project.urls)
  const projectRef = useRef(project)
  projectRef.current = project
  const dirty = useRef(false)
  useEffect(() => {
    setKind(sanitizeProjectKind(project.kind))
    setTargets(project.urls)
    dirty.current = false
  }, [project.id])

  useEffect(() => {
    if (!dirty.current) return
    const timer = window.setTimeout(() => {
      void window.ade.invoke('project:update', { id: projectRef.current.id, kind, urls: targets })
        .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
    }, SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [kind, targets, toast])

  const change = (next: ProjectTarget[]) => { dirty.current = true; setTargets(next) }
  const kindOptions = PROJECT_KINDS.map((value) => ({ value, label: t(`projectTargets.kind.${value}` as TranslationKey), testId: `project-kind-${value}` }))

  return <div className="pt-editor" data-testid="project-targets-editor">
    <div className="pt-editor__kind">
      <span className="pt-editor__caption">{t('projectTargets.kindLabel')}</span>
      <Segmented<ProjectKind> options={kindOptions} value={kind} ariaLabel={t('projectTargets.kindLabel')}
        onChange={(next) => { dirty.current = true; setKind(next) }} />
    </div>
    <p className="st-note">{t(kind === 'web' ? 'projectTargets.hintWeb' : 'projectTargets.hintApp')}</p>
    <span className="pt-editor__caption">{t('projectTargets.targets')}</span>
    {targets.length === 0 && <p className="st-note">{t('projectTargets.empty')}</p>}
    <ol className="pt-list">
      {targets.map((target, index) => <li key={target.id} className="pt-item" data-testid="project-target">
        <TargetFields target={target} kind={kind} onChange={(patch) => change(updateTarget(targets, target.id, patch))} />
        <div className="pt-item__actions">
          <IconButton size="sm" label={t('projectTargets.moveUp')} title={t('projectTargets.moveUp')} icon={<ArrowUp size={13} strokeWidth={1.5} />}
            disabled={index === 0} onClick={() => change(moveTarget(targets, index, index - 1))} data-testid="target-up" />
          <IconButton size="sm" label={t('projectTargets.moveDown')} title={t('projectTargets.moveDown')} icon={<ArrowDown size={13} strokeWidth={1.5} />}
            disabled={index === targets.length - 1} onClick={() => change(moveTarget(targets, index, index + 1))} data-testid="target-down" />
          <IconButton size="sm" label={t('common.delete')} title={t('common.delete')} icon={<Trash2 size={13} strokeWidth={1.5} />}
            onClick={() => change(removeTarget(targets, target.id))} data-testid="target-remove" />
        </div>
      </li>)}
    </ol>
    <div>
      <Button icon={<Plus size={14} strokeWidth={1.5} />} onClick={() => change(addTarget(targets, kind))} data-testid="target-add">{t('projectTargets.add')}</Button>
    </div>
  </div>
}

/**
 * サイドバーの「プロジェクトを編集」。名前と、種類・確認先（ProjectTargetsEditor）。
 * プロジェクトを足した直後にも開き、種類を選んでもらう。
 * 開いている間は呼び出し側が内蔵ブラウザのビューを隠す（Modal はネイティブのビューの下になるため）。
 */
export function ProjectEditDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const [name, setName] = useState(project.name)
  const commitName = () => {
    const next = name.trim()
    if (!next || next === project.name) return
    void window.ade.invoke('project:update', { id: project.id, name: next }).catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }
  return <Modal className="rv-modal" label={t('projectTargets.editTitle')} onClose={() => { commitName(); onClose() }}>
    <div className="rv-modal__panel pt-dialog" data-testid="project-edit-dialog">
      <header className="rv-modal__head pt-dialog__head">
        <h2>{t('projectTargets.editTitle')}</h2>
        <IconButton label={t('common.close')} icon={<X size={16} />} onClick={() => { commitName(); onClose() }} />
      </header>
      <p className="pt-dialog__path" title={project.folderPath}>{project.folderPath}</p>
      <label className="pt-field">
        <span>{t('projectTargets.projectName')}</span>
        <Field value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} data-testid="project-edit-name" />
      </label>
      <ProjectTargetsEditor project={project} />
      <div className="pt-dialog__actions">
        <Button variant="primary" onClick={() => { commitName(); onClose() }} data-testid="project-edit-done">{t('projectTargets.done')}</Button>
      </div>
    </div>
  </Modal>
}
