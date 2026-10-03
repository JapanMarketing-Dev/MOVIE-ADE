import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { Button } from './Button'
import { EmptyState } from './EmptyState'
import { reportRenderError } from '../lib/telemetry'

/**
 * 描画の失敗を1つの領域に閉じ込める。
 *
 * React は描画中の例外でツリー全体を外すので、どこか1か所が落ちるとアプリ全体が真っ黒になる。
 * ターミナル・サイドバー・中央などの主要な領域をこれで包み、落ちた領域にだけ
 * 「表示できませんでした」と、もう一度描く／アプリを再読み込みするボタンを出す。
 *
 * 子を描くあいだは余計な要素を足さない（グリッドの配置を崩さない）。失敗したときだけ
 * as / className で、元の領域と同じ箱（例: section.terminal-pane）を出して場所を保つ。
 * フックが使えない（クラスで書く必要がある）ので、文言は t() をその場で呼ぶ。
 */
export class ErrorBoundary extends Component<
  {
    /** どの領域か（ログと data-testid に使う） */
    name: string
    children: ReactNode
    /** 失敗したときに出す箱の要素名とクラス。元の領域と同じにすると、グリッドの場所がずれない */
    as?: 'div' | 'section' | 'aside'
    className?: string
  },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ui] ${this.props.name} を表示できませんでした`, error, info.componentStack)
    // Sentry へも送る（設定が OFF・E2E では何もしない。src/renderer/lib/telemetry.ts）
    reportRenderError(error, this.props.name, info.componentStack)
  }

  private readonly retry = (): void => this.setState({ error: null })

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const Box = this.props.as ?? 'div'
    return (
      <Box className={['error-boundary', this.props.className ?? ''].join(' ').trim()} data-testid={`error-boundary-${this.props.name}`}>
        <EmptyState
          size="sm"
          title={t('errorBoundary.title')}
          description={<><span>{t('errorBoundary.description')}</span><code className="error-boundary__detail">{error.message}</code></>}
          actions={
            <>
              <Button variant="default" onClick={this.retry}>{t('errorBoundary.retry')}</Button>
              <Button variant="ghost" onClick={() => window.location.reload()}>{t('errorBoundary.reload')}</Button>
            </>
          }
        />
      </Box>
    )
  }
}
