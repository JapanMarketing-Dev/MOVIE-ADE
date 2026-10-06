import { useEffect, useState } from 'react'
import { MAX_SHEET_COLUMNS, MAX_SHEET_ROWS } from '@shared/office/xlsx'
import { OfficeFormatError, officeKindOf, renderOffice, type OfficePreview } from '@shared/office'
import { formatByteSize, type FsFileInfo } from '@shared/fileViewer'
import { reportHandled } from '@shared/report'
import { Button, Spinner } from '../ui'
import { useT } from '../lib/i18n'

/**
 * Word・Excel・PowerPoint のプレビュー（中央のファイルタブの本体）。
 * 中身は fs:readOffice で受け取り、@shared/office が HTML にする。HTML は sandbox の iframe（スクリプト無し・
 * 外へ読みに行かない CSP）に出すので、文書の中の文字や画像がこの画面を動かすことはない。
 * Excel はシートを切り替えられ、開いたシートだけを HTML にする（大きいブックでも開くのが速い）。
 * 読めなかったら onError で大きさと16進数の表示に切り替える。
 */
export default function OfficeViewer({ path, name, info, revision, onError }: { path: string; name: string; info?: FsFileInfo; revision: number; onError: (message: string) => void }) {
  const t = useT()
  const [preview, setPreview] = useState<OfficePreview | null>(null)
  const [sheet, setSheet] = useState(0)
  const [sheetHtml, setSheetHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setPreview(null)
    const kind = officeKindOf(path)
    if (!kind) return
    void (async () => {
      try {
        const bytes = await window.ade.invoke('fs:readOffice', path)
        const result = await renderOffice(kind, bytes, name, {
          missingImage: t('viewer.officeMissingImage'),
          chart: t('viewer.officeChart'),
          slide: (n, total) => t('viewer.officeSlide', { n, total }),
          sheetTruncated: t('viewer.officeTruncated', { rows: MAX_SHEET_ROWS, columns: MAX_SHEET_COLUMNS })
        })
        if (cancelled) return
        setPreview(result)
        if (result.kind === 'sheets') setSheet((current) => (current < result.sheets.length ? current : Math.max(0, result.sheets.findIndex((s) => !s.hidden))))
      } catch (err) {
        if (cancelled) return
        // パスワード付き・壊れた文書（OfficeFormatError）は想定内なので送らない。読み取りの不具合だけ送る（中身は含めない）
        if (!(err instanceof OfficeFormatError)) reportHandled(err, { area: 'editor', op: `preview ${kind}` })
        onError(t('viewer.officeFailed'))
      }
    })()
    return () => { cancelled = true }
  }, [path, revision])

  useEffect(() => {
    setSheetHtml(null)
    if (preview?.kind !== 'sheets') return
    const target = preview.sheets[sheet]
    if (!target) return
    let cancelled = false
    target.render().then((html) => { if (!cancelled) setSheetHtml(html) }, (err) => {
      if (cancelled) return
      if (!(err instanceof OfficeFormatError)) reportHandled(err, { area: 'editor', op: 'preview xlsx sheet' })
      onError(t('viewer.officeFailed'))
    })
    return () => { cancelled = true }
  }, [preview, sheet])

  const html = preview ? (preview.kind === 'sheets' ? sheetHtml : preview.html) : null
  return (
    <div className="file-viewer file-viewer--office" data-testid="file-viewer-office">
      <div className="file-viewer__toolbar">
        {preview?.kind === 'sheets' && (
          <span className="file-viewer__sheets" role="tablist" aria-label={t('viewer.officeSheets')}>
            {preview.sheets.map((s, index) => (
              <Button key={index} variant="ghost" role="tab" aria-selected={index === sheet} selected={index === sheet} onClick={() => setSheet(index)} data-testid="file-viewer-sheet">
                {s.hidden ? t('viewer.officeHiddenSheet', { name: s.name }) : s.name}
              </Button>
            ))}
          </span>
        )}
        <span className="file-viewer__note">{t('viewer.officeNote')}</span>
        {info && <span className="file-viewer__meta">{formatByteSize(info.size)}</span>}
      </div>
      {html === null
        ? <div className="editor-body__center"><Spinner size={18} /></div>
        : <iframe className="file-viewer__office" sandbox="" srcDoc={html} title={t('viewer.officeTitle', { name })} data-testid="file-viewer-office-frame" />}
    </div>
  )
}
