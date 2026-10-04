import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 文字を打つ欄の Enter は、IME の確定の Enter で動かない（Orca #742 #17820 #24097）。
 * 日本語・中国語・韓国語で名前やタイトルを打つと、変換を確定した Enter で保存・実行されてしまう。
 * 欄で Enter を受けるファイルは、同じ行で isComposing を見ていること
 */
const FILES = [
  'src/renderer/components/ReviewFindings.tsx',
  'src/renderer/components/AccountsSection.tsx',
  'src/renderer/components/QuickLaunchButton.tsx',
  'src/renderer/ui/SttLanguageSelect.tsx',
  'src/renderer/components/ReviewList.tsx',
  'src/renderer/components/Sidebar.tsx',
  'src/renderer/components/UrlPresets.tsx',
  'src/renderer/components/ReviewTargetsPanel.tsx'
]

describe('文字を打つ欄の Enter は IME の確定で動かない', () => {
  for (const file of FILES) {
    it(file, () => {
      const lines = readFileSync(resolve(__dirname, '../..', file), 'utf8').split('\n')
      const unguarded = lines
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        // Enter と Space を同じに扱う行はボタン代わりの要素（文字を打たない）
        .filter(({ line }) => /key === 'Enter'/.test(line) && !/isComposing/.test(line) && !/=== ' '/.test(line))
      expect(unguarded).toEqual([])
    })
  }
})
