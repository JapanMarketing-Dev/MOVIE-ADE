import { useEffect, useMemo, useRef, useState } from 'react'
import { FileSearch } from 'lucide-react'
import { rankQuickOpenFiles } from '@shared/quickOpen'
import { errorMessage } from '../lib/errors'
import { Modal, Spinner } from '../ui'
import { useT } from '../lib/i18n'

/**
 * ⌘P のクイックオープン。ファイル名のあいまい一致で開く。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/quick-open-file-list.ts（MIT）
 *   - 開いた時点で一覧を1回取り（main は rg --files、.gitignore に従う）、絞り込みは手元で行う
 *   - 打ち切ったときはそれを示す
 * SSH・worktree の入れ子の除外・rg の案内は持ち込まない。
 *
 * 内蔵ブラウザのビューは DOM の上に重なるので、開いている間は呼び出し側でビューを隠すこと。
 */
export function QuickOpen({ onOpen, onClose }: { onOpen: (path: string) => void; onClose: () => void }) {
  const t = useT()
  const [files, setFiles] = useState<string[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    let cancelled = false
    window.ade.invoke('fs:files').then(
      (result) => { if (!cancelled) { setFiles(result.files); setTruncated(result.truncated) } },
      (err) => { if (!cancelled) setError(errorMessage(err)) }
    )
    return () => { cancelled = true }
  }, [])

  const results = useMemo(() => (files ? rankQuickOpenFiles(query, files) : []), [files, query])
  useEffect(() => setSelected(0), [query])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const choose = (path: string | undefined) => {
    if (!path) return
    onClose()
    onOpen(path)
  }

  return (
    <Modal className="rv-modal quick-open-modal" label={t('quickOpen.title')} onClose={onClose}>
      {/* 外側を押したら閉じる */}
      <div className="quick-open-shade" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="quick-open" data-testid="quick-open">
        <div className="quick-open__input">
          <FileSearch size={14} aria-hidden="true" />
          <input
            autoFocus
            value={query}
            placeholder={t('quickOpen.placeholder')}
            aria-label={t('quickOpen.placeholder')}
            aria-controls="quick-open-list"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((i) => Math.min(i + 1, results.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((i) => Math.max(i - 1, 0)) }
              else if (e.key === 'Enter') { e.preventDefault(); choose(results[selected]?.path) }
            }}
            data-testid="quick-open-input"
          />
        </div>
        {error ? (
          <p className="quick-open__note">{error}</p>
        ) : files === null ? (
          <div className="quick-open__note"><Spinner size={14} /> {t('quickOpen.loading')}</div>
        ) : results.length === 0 ? (
          <p className="quick-open__note">{t('fileExplorer.noMatches')}</p>
        ) : (
          <ul className="quick-open__list" id="quick-open-list" role="listbox" ref={listRef}>
            {results.map((result, index) => {
              const slash = result.path.lastIndexOf('/')
              return (
                <li
                  key={result.path}
                  role="option"
                  aria-selected={index === selected}
                  className="quick-open__item"
                  onMouseMove={() => setSelected(index)}
                  onClick={() => choose(result.path)}
                  data-testid="quick-open-item"
                >
                  <span className="quick-open__name">{result.path.slice(slash + 1)}</span>
                  <span className="quick-open__dir">{slash > 0 ? result.path.slice(0, slash) : ''}</span>
                </li>
              )
            })}
          </ul>
        )}
        {truncated && <p className="quick-open__note quick-open__note--foot">{t('quickOpen.truncated')}</p>}
      </div>
      </div>
    </Modal>
  )
}
