/**
 * Agent の CLI をアプリ内の小さなターミナルでインストールするときの、画面に依存しない部分（main・renderer・単体テストで共有）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/onboarding/OnboardingInlineCommandTerminal.tsx（MIT）。
 * Orca は開いたシェルにコマンドを貼り、OSC 133;D（シェル統合）で終了コードを受け取る。
 * 本システムにはシェル統合が無いので、コマンドの後ろに「終わったらその終了コードでシェルを閉じる」を付け、
 * PTY の終了コード（terminal:exit）をそのままコマンドの結果として使う。
 */

/** シェルのファイル名（/bin/zsh・pwsh.exe など）から、終わったら閉じる1行を作る */
export function exitWhenDoneCommand(command: string, shellFile: string): string {
  const name = (shellFile.split(/[\\/]/).pop() ?? shellFile).toLowerCase().replace(/\.exe$/, '')
  const line = command.trim()
  if (name === 'fish') return `${line}; exit $status`
  if (name === 'pwsh' || name === 'powershell') {
    // 外部コマンドの失敗は $? が false になる。見つからないときは $LASTEXITCODE が空なので 1 にする
    return `${line}; if ($?) { exit 0 } elseif ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }`
  }
  // cmd.exe は1行を読んだ時点で %errorlevel% を展開してしまうので、call で実行時に展開させる（Windows では未検証）
  if (name === 'cmd') return `${line} & call exit %^errorlevel%`
  // zsh / bash / sh など
  return `${line}; exit $?`
}

export type InstallOutcome = 'success' | 'failed' | 'missingTool'

/**
 * 終了コードの読み方。127 は POSIX のシェルの「コマンドが見つからない」（npm・brew・pip が無い）、
 * 9009 は cmd.exe の同じ意味の値
 */
export function installOutcome(exitCode: number | null): InstallOutcome {
  if (exitCode === 0) return 'success'
  if (exitCode === 127 || exitCode === 9009) return 'missingTool'
  return 'failed'
}

/** インストールに要る道具（コマンドの先頭の語）。見つからなかったときの案内に使う */
export function requiredInstallTool(command: string): string {
  return command.trim().split(/\s+/)[0] ?? ''
}
