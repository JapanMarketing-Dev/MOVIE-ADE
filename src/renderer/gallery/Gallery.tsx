import { useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Eraser,
  FolderOpen,
  Globe,
  Highlighter,
  Monitor,
  Pause,
  Plus,
  RotateCw,
  Smartphone,
  SquareTerminal,
  Trash2,
  Type,
  X
} from 'lucide-react'
import type { BrowserState } from '@shared/types'
import { FeedbackToolbar } from '../components/FeedbackToolbar'
import {
  Badge,
  Button,
  Card,
  CountBadge,
  EmptyState,
  Field,
  IconButton,
  Logo,
  Progress,
  RecordDot,
  Row,
  Segmented,
  Skeleton,
  Spinner,
  Stagger,
  ThemeSegmented,
  ThemeToggle,
  Tooltip,
  useToast
} from '../ui'
import { SHORTCUTS } from '../lib/shortcut'
import { useT } from '../lib/i18n'
import type { MessageKey } from '@shared/i18n'

/**
 * 部品見本。開発時だけ開く（表示メニュー → 部品見本、または URL の #gallery）。
 *
 * 後続のエージェントが「指摘一覧」「設定」「履歴」を作るときの参照先。
 * ここに無い見た目を画面側で作らないこと。足りなければ ui/ に部品を足して、
 * この見本にも並べる。
 */
export function Gallery({ onClose }: { onClose: () => void }) {
  const t = useT()
  return (
    <div className="gallery" data-testid="gallery">
      <header className="gallery__bar">
        <Logo size={18} />
        <h1 className="gallery__app">{t('gallery.title')}</h1>
        <span className="gallery__note">{t('gallery.note')}</span>
        <div className="gallery__bar-spacer" />
        <IconButton label={t('common.close')} icon={<X size={16} strokeWidth={1.75} />} onClick={onClose} />
      </header>

      <div className="gallery__scroll">
        <BrandSection />
        <ButtonSection />
        <ControlSection />
        <TabSection />
        <FeedbackBarSection />
        <FeedbackSection />
        <ListSection />
        <EmptySection />
      </div>
    </div>
  )
}

function Section({
  title,
  rule,
  children
}: {
  title: string
  /** この部品の使いどころ。見た目より先にこれを読ませる */
  rule: string
  children: React.ReactNode
}) {
  return (
    <section className="gallery__section">
      <div className="gallery__section-head">
        <h2 className="gallery__section-title">{title}</h2>
        <p className="gallery__section-rule">{rule}</p>
      </div>
      <div className="gallery__section-body">{children}</div>
    </section>
  )
}

function Specimen({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="specimen">
      <div className="specimen__stage">{children}</div>
      <span className="specimen__label">{label}</span>
    </div>
  )
}

/* ── ブランド ───────────────────────────────────────── */

const SURFACES: ReadonlyArray<readonly [MessageKey, string]> = [
  ['gallery.surface.app', '--color-bg-app'],
  ['gallery.surface.chrome', '--color-bg-chrome'],
  ['gallery.surface.panel', '--color-bg-panel'],
  ['gallery.surface.elevated', '--color-bg-elevated'],
  ['gallery.surface.hover', '--color-surface-hover'],
  ['gallery.surface.active', '--color-surface-active']
]

function BrandSection() {
  const t = useT()
  return (
    <Section title={t('gallery.brand.title')} rule={t('gallery.brand.rule')}>
      <div className="gallery__grid">
        <Specimen label={t('gallery.brand.logo')}>
          <div className="gallery__row">
            <Logo size={56} />
            <Logo size={24} />
            <Logo size={18} />
            <Logo size={16} />
          </div>
        </Specimen>
        <Specimen label={t('gallery.brand.theme')}>
          <div className="gallery__row">
            <ThemeSegmented />
            <ThemeToggle />
          </div>
        </Specimen>
      </div>

      <div className="swatches">
        {SURFACES.map(([label, token]) => (
          <div key={token} className="swatch">
            <span className="swatch__chip" style={{ background: `var(${token})` }} />
            <span className="swatch__label">{t(label)}</span>
            <code className="swatch__token">{token}</code>
          </div>
        ))}
      </div>

      <div className="gallery__grid">
        <Specimen label={t('gallery.brand.primaryLine')}>
          <span className="gallery__wire" />
        </Specimen>
        <Specimen label={t('gallery.brand.recordLine')}>
          <span className="gallery__wire gallery__wire--record" />
        </Specimen>
      </div>
    </Section>
  )
}

/* ── ボタン ─────────────────────────────────────────── */

function ButtonSection() {
  const t = useT()
  const [selected, setSelected] = useState(true)

  return (
    <Section title={t('gallery.buttons.title')} rule={t('gallery.buttons.rule')}>
      <div className="gallery__grid">
        <Specimen label={t('gallery.buttons.primary')}>
          <Button variant="primary" icon={<FolderOpen size={16} strokeWidth={1.75} />}>
            {t('gallery.sample.openFolder')}
          </Button>
        </Specimen>
        <Specimen label={t('gallery.buttons.default')}>
          <Button icon={<RotateCw size={16} strokeWidth={1.75} />}>{t('gallery.sample.reload')}</Button>
        </Specimen>
        <Specimen label={t('gallery.buttons.ghost')}>
          <Button variant="ghost" icon={<Globe size={16} strokeWidth={1.75} />}>
            {t('gallery.sample.open')}
          </Button>
        </Specimen>
        <Specimen label={t('gallery.buttons.danger')}>
          <Button variant="danger" icon={<Trash2 size={16} strokeWidth={1.75} />}>
            {t('gallery.sample.deleteFinding')}
          </Button>
        </Specimen>
        <Specimen label={t('gallery.buttons.record')}>
          <Button variant="record" icon={<RecordDot />}>
            {t('record.buttonRecord')}
          </Button>
        </Specimen>
        <Specimen label={t('gallery.buttons.recording')}>
          <Button variant="record" selected icon={<RecordDot active />}>
            {t('record.buttonStop')}
          </Button>
        </Specimen>
        <Specimen label={t('gallery.buttons.disabled')}>
          <Button disabled icon={<FolderOpen size={16} strokeWidth={1.75} />}>
            {t('gallery.sample.openFolder')}
          </Button>
        </Specimen>
        <Specimen label={t('gallery.buttons.disabledPrimary')}>
          <Button variant="primary" disabled>
            {t('gallery.sample.send')}
          </Button>
        </Specimen>
        <Specimen label={t('gallery.buttons.busy')}>
          <Button variant="primary" busy>
            {t('gallery.sample.organizing')}
          </Button>
        </Specimen>
        <Specimen label={t('gallery.buttons.toggle')}>
          <Button
            variant="ghost"
            selected={selected}
            icon={<Highlighter size={16} strokeWidth={1.75} />}
            onClick={() => setSelected((value) => !value)}
          >
            {t('gallery.sample.pen')}
          </Button>
        </Specimen>
      </div>

      <div className="gallery__grid">
        <Specimen label={t('gallery.buttons.icon')}>
          <div className="gallery__row">
            <IconButton label={t('gallery.sample.back')} icon={<ArrowLeft size={16} strokeWidth={1.75} />} />
            <IconButton label={t('gallery.sample.forward')} icon={<ArrowRight size={16} strokeWidth={1.75} />} />
            <IconButton label={t('gallery.sample.reload')} icon={<RotateCw size={16} strokeWidth={1.75} />} />
            <IconButton label={t('gallery.sample.text')} icon={<Type size={16} strokeWidth={1.75} />} />
            <IconButton label={t('gallery.sample.erase')} icon={<Eraser size={16} strokeWidth={1.75} />} />
          </div>
        </Specimen>
        <Specimen label={t('gallery.buttons.iconStates')}>
          <div className="gallery__row">
            <IconButton label={t('gallery.sample.pause')} disabled icon={<Pause size={16} strokeWidth={1.75} />} />
            <IconButton label={t('gallery.sample.pen')} selected icon={<Highlighter size={16} strokeWidth={1.75} />} />
            <IconButton label={t('common.close')} size="sm" icon={<X size={12} strokeWidth={2} />} />
          </div>
        </Specimen>
        <Specimen label={t('gallery.buttons.tooltip')}>
          <div className="gallery__row">
            <Tooltip label={t('gallery.sample.openFolder')} shortcut={SHORTCUTS.openFolder()}>
              <IconButton label={t('gallery.sample.folder')} icon={<FolderOpen size={16} strokeWidth={1.75} />} />
            </Tooltip>
            <Tooltip label={t('gallery.sample.reload')} shortcut={SHORTCUTS.reload()} side="top">
              <IconButton label={t('gallery.sample.reload')} icon={<RotateCw size={16} strokeWidth={1.75} />} />
            </Tooltip>
          </div>
        </Specimen>
      </div>
    </Section>
  )
}

/* ── 切替・入力 ─────────────────────────────────────── */

function ControlSection() {
  const t = useT()
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop')
  const [text, setText] = useState('http://localhost:3000/pricing')

  return (
    <Section title={t('gallery.controls.title')} rule={t('gallery.controls.rule')}>
      <div className="gallery__grid">
        <Specimen label={t('gallery.controls.segmented')}>
          <Segmented
            ariaLabel={t('gallery.controls.viewport')}
            value={viewport}
            onChange={setViewport}
            options={[
              { value: 'desktop', label: t('gallery.controls.desktop'), icon: <Monitor size={14} strokeWidth={1.75} /> },
              { value: 'mobile', label: t('gallery.controls.mobile'), icon: <Smartphone size={14} strokeWidth={1.75} /> }
            ]}
          />
        </Specimen>
        <Specimen label={t('gallery.controls.input')}>
          <Field
            icon={<Globe size={14} strokeWidth={1.75} />}
            mono
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-label="URL"
          />
        </Specimen>
        <Specimen label={t('gallery.controls.inputTrailing')}>
          <Field
            icon={<Globe size={14} strokeWidth={1.75} />}
            mono
            defaultValue="localhost:5173"
            trailing={<Spinner size={12} />}
            aria-label="URL"
          />
        </Specimen>
        <Specimen label={t('gallery.controls.inputInvalid')}>
          <div className="gallery__stack">
            <Field invalid defaultValue="htt;//" aria-label={t('gallery.controls.invalidValue')} />
            <Field disabled defaultValue={t('gallery.controls.notEditable')} aria-label={t('gallery.buttons.disabled')} />
          </div>
        </Specimen>
      </div>

      <div className="gallery__grid">
        <Specimen label={t('gallery.controls.badges')}>
          <div className="gallery__row">
            <Badge>{t('gallery.badge.unsent')}</Badge>
            <Badge tone="brand">{t('demo.speaker.me')}</Badge>
            <Badge tone="success">{t('gallery.badge.sent')}</Badge>
            <Badge tone="warning">{t('gallery.badge.needsReview')}</Badge>
            <Badge tone="danger">{t('gallery.badge.failed')}</Badge>
            <Badge tone="record">{t('gallery.badge.recording')}</Badge>
          </div>
        </Specimen>
        <Specimen label={t('gallery.controls.counts')}>
          <div className="gallery__row">
            <CountBadge count={3} />
            <CountBadge count={12} tone="neutral" />
            <CountBadge count={128} tone="record" />
          </div>
        </Specimen>
      </div>
    </Section>
  )
}

/* ── タブ ───────────────────────────────────────────── */

function TabSection() {
  const t = useT()
  const [active, setActive] = useState('a')
  const [tabs, setTabs] = useState([
    { key: 'a', title: 'zsh' },
    { key: 'b', title: 'claude' }
  ])
  let seq = tabs.length

  return (
    <Section title={t('gallery.tabs.title')} rule={t('gallery.tabs.rule')}>
      <div className="gallery__tabstrip">
        <div className="terminal-tabs" role="tablist">
          {tabs.map((tab, index) => (
            <div
              key={tab.key}
              className="terminal-tab"
              role="tab"
              aria-selected={tab.key === active}
              onClick={() => setActive(tab.key)}
            >
              <span className="terminal-tab__icon" aria-hidden="true">
                <SquareTerminal size={14} strokeWidth={1.75} />
              </span>
              <span className="terminal-tab__title">
                {index + 1}: {tab.title}
              </span>
              <button
                type="button"
                className="terminal-tab__close"
                aria-label={t('gallery.tabs.close', { name: tab.title })}
                onClick={(event) => {
                  event.stopPropagation()
                  setTabs((prev) => prev.filter((item) => item.key !== tab.key))
                }}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="terminal-tabs__add"
            aria-label={t('menu.newTerminal')}
            onClick={() => {
              const key = `t${++seq}${Date.now()}`
              setTabs((prev) => [...prev, { key, title: 'zsh' }])
              setActive(key)
            }}
          >
            <Plus size={14} strokeWidth={2} />
          </button>
        </div>
      </div>
      <p className="gallery__hint">{t('gallery.tabs.hint')}</p>

      <div className="gallery__grid">
        <Specimen label={t('gallery.tabs.agentState')}>
          <div className="gallery__row">
            {(
              [
                ['working', 'gallery.tabs.working'],
                ['blocked', 'gallery.tabs.blocked'],
                ['done', 'gallery.tabs.done'],
                ['idle', 'gallery.tabs.idle'],
                ['unknown', 'gallery.tabs.unknown']
              ] as const
            ).map(([state, label]) => (
              <span key={state} className="gallery__agent">
                <span className={`terminal-tab__state terminal-tab__state--${state}`} />
                {t(label)}
              </span>
            ))}
          </div>
        </Specimen>
      </div>
      <p className="gallery__hint">{t('gallery.tabs.doneHint')}</p>
    </Section>
  )
}

/* ── フィードバックモードのツールバー ───────────────── */

function FeedbackBarSection() {
  const t = useT()
  const sampleState: BrowserState = {
    url: 'http://localhost:3000/pricing',
    title: t('gallery.feedbackBar.pageTitle'),
    canGoBack: true,
    canGoForward: false,
    loading: false,
    viewport: 'desktop'
  }
  return (
    <Section title={t('gallery.feedbackBar.title')} rule={t('gallery.feedbackBar.rule')}>
      <div className="gallery__bars">
        <div className="gallery__bar-specimen">
          <FeedbackToolbar
            state={sampleState}
            recording={false}
            elapsed="00:00"
            onToggleRecording={() => {}}
            onBackToEditor={() => {}}
          />
          <span className="specimen__label">{t('gallery.feedbackBar.stopped')}</span>
        </div>
        <div className="gallery__bar-specimen">
          <FeedbackToolbar
            state={sampleState}
            recording
            elapsed="04:17"
            tool="pen"
            onToggleRecording={() => {}}
            onBackToEditor={() => {}}
          />
          <span className="specimen__label">{t('gallery.feedbackBar.recording')}</span>
        </div>
      </div>
    </Section>
  )
}

/* ── 進行・通知 ─────────────────────────────────────── */

function FeedbackSection() {
  const t = useT()
  const toast = useToast()

  return (
    <Section title={t('gallery.progress.title')} rule={t('gallery.progress.rule')}>
      <div className="gallery__grid">
        <Specimen label={t('gallery.progress.spinner')}>
          <div className="gallery__row">
            <Spinner size={20} />
            <Spinner size={16} />
            <Spinner size={12} />
          </div>
        </Specimen>
        <Specimen label={t('gallery.progress.determinate')}>
          <Progress value={0.62} label={t('gallery.progress.transcribing')} />
        </Specimen>
        <Specimen label={t('gallery.progress.indeterminate')}>
          <Progress label={t('gallery.sample.organizing')} />
        </Specimen>
        <Specimen label={t('gallery.progress.skeleton')}>
          <div className="gallery__stack">
            <Skeleton width="70%" />
            <Skeleton width="45%" />
          </div>
        </Specimen>
        <Specimen label={t('gallery.progress.recordDot')}>
          <div className="gallery__row">
            <RecordDot />
            <RecordDot active />
            <RecordDot active size={12} />
          </div>
        </Specimen>
      </div>

      <div className="gallery__grid">
        <Specimen label={t('gallery.toast.label')}>
          <div className="gallery__row">
            <Button onClick={() => toast({ message: t('gallery.toast.infoMessage') })}>{t('gallery.toast.info')}</Button>
            <Button
              onClick={() =>
                toast({ tone: 'success', message: t('gallery.toast.successMessage'), detail: './ade-feedback/2026-10-02/' })
              }
            >
              {t('gallery.toast.success')}
            </Button>
            <Button
              onClick={() =>
                toast({ tone: 'warning', message: t('gallery.toast.warningMessage') })
              }
            >
              {t('gallery.toast.warning')}
            </Button>
            <Button
              onClick={() =>
                toast({
                  tone: 'danger',
                  message: t('gallery.toast.dangerMessage'),
                  detail: t('gallery.toast.dangerDetail')
                })
              }
            >
              {t('gallery.toast.danger')}
            </Button>
          </div>
        </Specimen>
      </div>
    </Section>
  )
}

/* ── 一覧 ───────────────────────────────────────────── */

const SAMPLE_ROWS = [
  { time: '01:42', title: 'gallery.row1.title', body: 'gallery.row1.body', tone: 'brand', tag: 'demo.speaker.me' },
  { time: '03:08', title: 'gallery.row2.title', body: 'gallery.row2.body', tone: 'brand', tag: 'demo.speaker.other' },
  { time: '05:20', title: 'gallery.row3.title', body: 'gallery.row3.body', tone: 'warning', tag: 'gallery.badge.needsReview' }
] as const satisfies ReadonlyArray<{ time: string; title: MessageKey; body: MessageKey; tone: 'brand' | 'warning'; tag: MessageKey }>

function ListSection() {
  const t = useT()
  const [selected, setSelected] = useState('01:42')

  return (
    <Section title={t('gallery.list.title')} rule={t('gallery.list.rule')}>
      <Card
        title={t('gallery.list.card', { count: SAMPLE_ROWS.length })}
        actions={
          <>
            <Button variant="ghost">{t('gallery.list.copy')}</Button>
            <Button variant="primary">{t('gallery.list.send')}</Button>
          </>
        }
      >
        <div className="gallery__rows">
          <Stagger>
            {SAMPLE_ROWS.map((item) => (
              <Row
                key={item.time}
                selected={selected === item.time}
                onClick={() => setSelected(item.time)}
                leading={<span className="gallery__thumb" aria-hidden="true" />}
                title={t(item.title)}
                meta={item.time}
                description={t(item.body)}
                trailing={<Badge tone={item.tone}>{t(item.tag)}</Badge>}
              />
            ))}
          </Stagger>
        </div>
      </Card>
    </Section>
  )
}

/* ── 空状態 ─────────────────────────────────────────── */

function EmptySection() {
  const t = useT()
  return (
    <Section title={t('gallery.empty.title')} rule={t('gallery.empty.rule')}>
      <div className="gallery__empties">
        <div className="gallery__empty-frame">
          <EmptyState
            art={<Logo size={48} />}
            title={t('gallery.empty.projectTitle')}
            description={t('gallery.empty.projectDescription')}
            actions={
              <Button variant="primary" icon={<FolderOpen size={16} strokeWidth={1.75} />}>
                {t('gallery.sample.openFolder')}
              </Button>
            }
            hints={<span>{t('gallery.sample.openFolder')} · {SHORTCUTS.openFolder()}</span>}
          />
        </div>
        <div className="gallery__empty-frame">
          <EmptyState
            size="sm"
            art={<SquareTerminal size={28} strokeWidth={1.5} />}
            title={t('gallery.empty.shellTitle')}
            description={t('gallery.empty.shellDescription')}
            actions={
              <Button icon={<Plus size={16} strokeWidth={1.75} />}>{t('gallery.empty.shellTitle')}</Button>
            }
            hints={<span>{t('gallery.empty.newTab')} · {SHORTCUTS.newTerminal()}</span>}
          />
        </div>
      </div>
    </Section>
  )
}
