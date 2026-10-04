import { FileText, Monitor, Palette, type LucideProps } from 'lucide-react'
import type { TargetPurpose } from '@shared/types'

/**
 * 確認先の区分（アプリ・デザイン・設計書）のアイコン。ツールバーの確認先・右パネルの候補・停止後のまとめで同じものを使う。
 * 文字の説明は呼び出し側が付ける（ここは飾りなので aria-hidden）
 */
const ICONS: Record<TargetPurpose, typeof Monitor> = { app: Monitor, design: Palette, doc: FileText }

export function TargetPurposeIcon({ purpose, ...props }: { purpose: TargetPurpose } & LucideProps) {
  const Icon = ICONS[purpose]
  return <Icon size={11} strokeWidth={1.75} aria-hidden="true" data-purpose-icon={purpose} {...props} />
}
