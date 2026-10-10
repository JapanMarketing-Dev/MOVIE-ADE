import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { extractJsonObject } from './identity'

/**
 * Claude in Chrome とつながる Claude Code のアカウントを見分ける。
 *
 * Claude in Chrome の拡張機能は、拡張機能と Claude Code が同じ claude.ai のアカウントにログインしているときだけつながる
 * （Claude Code 2.1.296 の文言「make sure you're signed in to the same claude.ai account」、
 * ローカルの接続も双方のアカウントの署名つきの身元を見て組む）。
 * Ferret が別のアカウント（CLAUDE_CONFIG_DIR）で Claude Code を起動すると、そのタブでは Chrome がつながらない。
 *
 * つながったことのある設定には、Claude Code が .claude.json に chromeExtension.pairedDeviceId を書く。
 * これのある設定フォルダのアカウントを「Chrome のアカウント」とみなす。値（端末の ID）そのものは返さない・送らない。
 */

/** .claude.json の本文に、Claude in Chrome とつないだ印（chromeExtension.pairedDeviceId）があるか */
export function hasChromePairing(text: string): boolean {
  const slice = extractJsonObject(text, 'chromeExtension')
  if (!slice) return false
  try {
    const value = JSON.parse(slice) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const id = (value as { pairedDeviceId?: unknown }).pairedDeviceId
    return typeof id === 'string' && id.trim().length > 0
  } catch {
    // 壊れた設定は「つないでいない」として扱う（想定内）
    return false
  }
}

async function anyPaired(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    const text = await readFile(path, 'utf8').catch(() => null) // 無い（まだ起動していない）は想定内
    if (text !== null) return hasChromePairing(text)
  }
  return false
}

/** 管理アカウントの設定フォルダ（CLAUDE_CONFIG_DIR）が Claude in Chrome とつないだことがあるか */
export function managedClaudeChromePaired(configDir: string): Promise<boolean> {
  return anyPaired([join(configDir, '.claude.json'), join(configDir, '.config.json')])
}

/** システムの既定アカウント。CLAUDE_CONFIG_DIR を引き継いでいればその中、無ければ ~/.claude/.claude.json か ~/.claude.json */
export function systemClaudeChromePaired(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Promise<boolean> {
  const inherited = env.CLAUDE_CONFIG_DIR?.trim()
  if (inherited) return managedClaudeChromePaired(inherited)
  return anyPaired([join(home, '.claude', '.claude.json'), join(home, '.claude.json')])
}
