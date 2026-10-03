/**
 * README・サイトのロゴ一覧（src/shared/agentLogos.ts と docs/images/agents/agents.json）。
 * 画像が実在し、JSON が TS の一覧とずれていないことだけを見る。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS, ORCA_SUPPORTED_AGENTS } from '@shared/agentCatalog'
import { agentLogoList } from '@shared/agentLogos'

const root = join(__dirname, '..', '..')

describe('agentLogoList', () => {
  const logos = agentLogoList()

  it('組み込みのすべてを1回ずつ、Orca の README の順を先頭に並べる', () => {
    expect(logos.map((logo) => logo.id).sort()).toEqual([...BUILTIN_AGENTS].sort())
    expect(logos.slice(0, ORCA_SUPPORTED_AGENTS.length).map((logo) => logo.id)).toEqual([...ORCA_SUPPORTED_AGENTS])
  })

  it('Orca の README に載っているものはすべてロゴがあり、ロゴの画像は実在する', () => {
    for (const logo of logos) {
      if (ORCA_SUPPORTED_AGENTS.includes(logo.id)) expect(logo.icon, logo.id).not.toBeNull()
      if (logo.icon) expect(existsSync(join(root, logo.icon)), logo.icon).toBe(true)
      expect(logo.homepageUrl).toMatch(/^https:\/\//)
    }
  })

  it('docs/images/agents/agents.json は TS の一覧と同じ（ずれたら作り直す）', () => {
    const json = JSON.parse(readFileSync(join(root, 'docs/images/agents/agents.json'), 'utf8')) as { agents: unknown }
    expect(json.agents).toEqual(logos)
  })
})
