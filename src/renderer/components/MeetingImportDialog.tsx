import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, FileText, Film, Users, X } from 'lucide-react'
import { isOrganizeRunnerId, RECOMMENDED_ORGANIZE_PROVIDER, type OrganizeRunnerId } from '@shared/aiProviders'
import type { MeetingImportProgress, MeetingMediaPick } from '@shared/meetingImport'
import { parseMeetingTranscript } from '@shared/meetingTranscript'
import type { ReviewData } from '@shared/review'
import { Button, IconButton, Modal, Progress, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'
import '../styles/github.css'

/**
 * mtg の録画・文字起こしを取り込む（@shared/meetingImport の流れ）。
 *   1. 動画（任意）と文字起こし（ファイルか貼り付け。任意）を選ぶ。どちらか一方は要る
 *   2. 取り込む → 新しいレビュー（下書き）→ 指摘の整理（設定の整理のモデル）→ 判定モデルの確からしさ（有効なら）
 *   3. 終わったらレビューを開く。人が候補を確かめ（外す・直す・画像を替える）、Agent へ送る
 * 整理・判定が使えなくても、下書きのまま開く（理由は知らせる）
 */
export function MeetingImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (review: ReviewData) => void }) {
  const t = useT()
  const toast = useToast()
  const [media, setMedia] = useState<MeetingMediaPick | null>(null)
  const [transcript, setTranscript] = useState<{ name?: string; text: string }>({ text: '' })
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<MeetingImportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [runner, setRunner] = useState<OrganizeRunnerId>(`api:${RECOMMENDED_ORGANIZE_PROVIDER}`)

  useEffect(() => {
    void window.ade.invoke('app:settings').then((s) => { if (isOrganizeRunnerId(s.organizer?.runner)) setRunner(s.organizer.runner) })
      .catch(() => undefined) // 既定（おすすめの Ollama）のまま
    return window.ade.on('meeting:progress', setProgress)
  }, [])

  // 取り込む前に「何件・何人・時刻の有無」を出す（読めない形なら段落ごとになる）
  const parsed = useMemo(() => (transcript.text.trim() ? parseMeetingTranscript(transcript.text, transcript.name ?? '') : null), [transcript])
  const ready = !busy && (!!media || (parsed?.utterances.length ?? 0) > 0)

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      let review = await window.ade.invoke('meeting:import', {
        ...(media ? { mediaToken: media.token } : {}),
        ...(transcript.text.trim() ? { transcript: { text: transcript.text, ...(transcript.name ? { name: transcript.name } : {}) } } : {})
      })
      const notes: string[] = []
      // 整理（発話から指摘の候補を作る）。失敗しても下書きのまま進む
      setProgress({ stage: 'draft' })
      try {
        if (review.canOrganize) review = await window.ade.invoke('review:organize', review.id, runner)
      } catch (err) {
        notes.push(t('meeting.organizeSkipped', { reason: errorMessage(err) }))
      }
      // 判定（有効なときだけ点を付け、低い候補を送る対象から外す）
      try {
        const scored = await window.ade.invoke('meeting:score', review.id)
        review = scored.review
        if (scored.result.skipped) notes.push(t('meeting.scoreSkipped', { reason: scored.result.skipped }))
        else notes.push(t('meeting.scored', { scored: scored.result.scored, excluded: scored.result.excluded }))
      } catch (err) {
        notes.push(t('meeting.scoreSkipped', { reason: errorMessage(err) }))
      }
      toast({ tone: 'success', message: t('meeting.done', { count: review.document.items.length }), detail: notes.join(' ') })
      onImported(review)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const pickMedia = async () => {
    try {
      const picked = await window.ade.invoke('meeting:pickMedia')
      if (picked) setMedia(picked)
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  const pickTranscript = async () => {
    try {
      const picked = await window.ade.invoke('meeting:pickTranscript')
      if (picked) setTranscript({ name: picked.name, text: picked.text })
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const stageLabel = progress ? t(`meeting.stage.${progress.stage}`) : ''
  const fraction = progress?.total ? Math.min(1, (progress.done ?? 0) / progress.total) : undefined

  return <Modal className="rv-modal" label={t('meeting.title')} onClose={() => !busy && onClose()}>
    <div className="gh-send meeting-import" data-testid="meeting-import-dialog">
      <header className="gh-send__head">
        <h2><Users size={15} aria-hidden="true" />{t('meeting.title')}</h2>
        <IconButton label={t('common.close')} icon={<X size={16} />} disabled={busy} onClick={onClose} />
      </header>
      <p className="st-note">{t('meeting.intro')}</p>

      <div className="gh-send__field">
        <span className="gh-send__label">{t('meeting.media.label')}</span>
        <div className="meeting-import__row">
          <Button variant="default" icon={<Film size={13} />} disabled={busy} onClick={() => void pickMedia()} data-testid="meeting-pick-media">{t('meeting.media.pick')}</Button>
          {media
            ? <span className="meeting-import__file" title={media.name}>{media.name}<span className="st-note">{formatBytes(media.sizeBytes)}</span>
              <IconButton size="sm" label={t('meeting.media.remove')} icon={<X size={12} />} disabled={busy} onClick={() => setMedia(null)} /></span>
            : <span className="st-note">{t('meeting.media.hint')}</span>}
        </div>
      </div>

      <label className="gh-send__field">
        <span className="gh-send__label">{t('meeting.transcript.label')}</span>
        <textarea className="gh-send__input meeting-import__text" rows={8} value={transcript.text} disabled={busy} spellCheck={false}
          placeholder={t('meeting.transcript.placeholder')} onChange={(e) => setTranscript({ text: e.target.value })} data-testid="meeting-transcript" />
      </label>
      <div className="meeting-import__row">
        <Button variant="ghost" icon={<FileText size={13} />} disabled={busy} onClick={() => void pickTranscript()} data-testid="meeting-pick-transcript">{t('meeting.transcript.pick')}</Button>
        {parsed && <span className="st-note" data-testid="meeting-transcript-summary">{t(parsed.timed ? 'meeting.transcript.summaryTimed' : 'meeting.transcript.summaryUntimed', {
          count: parsed.utterances.length, speakers: parsed.speakers.length ? parsed.speakers.slice(0, 6).join(', ') : t('meeting.transcript.noSpeakers')
        })}</span>}
      </div>
      <p className="st-note">{t('meeting.howItWorks')}</p>

      {error && <p className="st-note st-note--warn" role="alert"><CircleAlert size={12} aria-hidden="true" />{error}</p>}
      {busy && <div className="meeting-import__progress" role="status">
        <Progress value={fraction} label={stageLabel} />
        <span className="st-note">{stageLabel}{progress?.total ? ` ${progress.done ?? 0}/${progress.total}` : ''}</span>
      </div>}

      <div className="gh-send__foot">
        <Button variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={!ready} onClick={() => void run()} data-testid="meeting-import-run">{t('meeting.run')}</Button>
      </div>
    </div>
  </Modal>
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
