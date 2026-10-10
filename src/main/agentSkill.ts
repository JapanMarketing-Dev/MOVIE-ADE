import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AGENT_SKILL_AGENTS,
  agentConfigDir,
  agentSkillPath,
  isFerretSkill,
  renderAgentSkill,
  type AgentSkillAgent,
  type AgentSkillStatus,
  type SkillContext
} from '@shared/agentSkill'

/**
 * Ferret の設定を変える skill を、Claude Code・Codex の skills のフォルダへ入れる（@shared/agentSkill）。
 *
 * Agent の設定のフォルダはふだん読むだけにしている（agentResources・accounts）。ここで書くのは、
 * 利用者が［入れる］を押したとき（main の操作の許可を通したあと）と、入れてある Ferret の skill を今の設定に合わせるときだけで、
 * 書くのは <設定のフォルダ>/skills/ferret-settings/SKILL.md の1つだけ。ほかのファイルには触れない。
 * - 同じ名前で Ferret のものでない skill（印が無い）があれば書かない
 * - SKILL.md・そのフォルダがリンクなら書かない（別の場所を書き換えさせない）
 * - 一時ファイルに書いてから置き換える
 */

export interface AgentSkillEnv {
  env: Record<string, string | undefined>
  home: string
}

const defaultEnv = (): AgentSkillEnv => ({ env: process.env, home: homedir() })

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

async function isLink(path: string): Promise<boolean> {
  try { return (await lstat(path)).isSymbolicLink() } catch { return false }
}

async function readSkill(path: string): Promise<string | null> {
  try {
    if (await isLink(path)) return null
    return await readFile(path, 'utf8')
  } catch {
    return null // 無い（想定内）
  }
}

export async function agentSkillStatus(context: SkillContext, where: AgentSkillEnv = defaultEnv()): Promise<AgentSkillStatus[]> {
  const expected = renderAgentSkill(context)
  return Promise.all(AGENT_SKILL_AGENTS.map(async (agent) => {
    const path = agentSkillPath(agent, where.env, where.home, join)
    const text = await readSkill(path)
    const ours = text !== null && isFerretSkill(text)
    return {
      agent,
      path,
      agentDirExists: await exists(agentConfigDir(agent, where.env, where.home, join)),
      installed: ours,
      foreign: (text !== null && !ours) || (await isLink(path)) || (await isLink(dirname(path))),
      upToDate: ours && text === expected
    }
  }))
}

/**
 * skill を入れる（入れてあれば書き直す）。agents を省くと、設定のフォルダがある Agent（使っている Agent）すべて。
 * どれも無ければ Claude Code に入れる（あとから入れた Claude Code が読む）
 */
export async function installAgentSkill(context: SkillContext, agents?: readonly AgentSkillAgent[], where: AgentSkillEnv = defaultEnv()): Promise<AgentSkillStatus[]> {
  const status = await agentSkillStatus(context, where)
  const wanted = agents ?? (status.some((s) => s.agentDirExists) ? status.filter((s) => s.agentDirExists).map((s) => s.agent) : ['claude' as const])
  const text = renderAgentSkill(context)
  for (const item of status) {
    if (!wanted.includes(item.agent) || item.foreign || item.upToDate) continue
    await writeSkill(item.path, text)
  }
  return agentSkillStatus(context, where)
}

/**
 * 入れてある Ferret の skill を、今の設定の項目と置き場所に合わせて書き直す（起動時）。
 * 入れていない Agent には足さない。書き直したものの数を返す
 */
export async function syncAgentSkill(context: SkillContext, where: AgentSkillEnv = defaultEnv()): Promise<number> {
  const status = await agentSkillStatus(context, where)
  const stale = status.filter((s) => s.installed && !s.foreign && !s.upToDate)
  const text = renderAgentSkill(context)
  for (const item of stale) await writeSkill(item.path, text)
  return stale.length
}

export async function writeSkill(path: string, text: string): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o755 })
  if (await isLink(dir) || await isLink(path)) throw new Error(`refusing to write the skill through a symbolic link: ${path}`)
  const tmp = join(dir, `.SKILL.md.${process.pid}.${Date.now().toString(36)}.tmp`)
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
