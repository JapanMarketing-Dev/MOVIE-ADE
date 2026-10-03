import type { BuiltinAgent, PlatformName } from '@shared/types'
import { AGENT_CATALOG } from '@shared/agentCatalog'

/**
 * Windows では動かない入れ方。POSIX のシェル向け（curl … | bash / sh、sh -c "$(curl …)"）と、
 * Windows に無い Homebrew（brew install …）
 */
export function isPosixOnlyInstall(command: string): boolean {
  return /\|\s*(?:ba|z)?sh\b/.test(command) || /^\s*sh\s+-c\b/.test(command) || /^\s*brew\s/.test(command)
}

/** 今の OS（renderer は preload の platform。無ければ darwin 扱い＝カタログの install をそのまま出す） */
function currentPlatform(): PlatformName {
  return (globalThis as { window?: { ade?: { platform?: PlatformName } } }).window?.ade?.platform ?? 'darwin'
}

/**
 * 見つからなかった Agent の CLI のインストールコマンド（AgentInstallTerminal で、押したときだけ実行する）。
 * 正本はカタログ（src/shared/agentCatalog.ts）。OS ごとに出し分ける:
 *   - Windows: installWindows（公式の Windows の手順）があればそれ。無く、install が POSIX のシェル向けなら undefined
 *     （公式ページへのリンクだけを出す）。npm / pip などの OS に関係ないコマンドはそのまま
 *   - Linux: installLinux（install が macOS の Homebrew だけのもの）があればそれ。無ければ install
 *   - macOS: install
 * どれも無いもの（ソースからしか入れられないなど）は undefined
 */
export function agentInstallCommand(agent: BuiltinAgent, platform: PlatformName = currentPlatform()): string | undefined {
  const entry = AGENT_CATALOG[agent]
  if (!entry) return undefined
  if (platform === 'win32') {
    const windows = entry.installWindows?.trim()
    if (windows) return windows
    const install = entry.install.trim()
    return install && !isPosixOnlyInstall(install) ? install : undefined
  }
  if (platform === 'linux') {
    const linux = entry.installLinux?.trim()
    if (linux) return linux
  }
  return entry.install.trim() || undefined
}
