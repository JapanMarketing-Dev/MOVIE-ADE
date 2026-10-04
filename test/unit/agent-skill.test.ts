import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { AGENT_SKILL_NAME, SKILL_MARKER, agentSkillPath, isFerretSkill, renderAgentSkill } from '../../src/shared/agentSkill'
import { SETTINGS_SCHEMA } from '../../src/shared/settingsSchema'
import { agentSkillStatus, installAgentSkill, syncAgentSkill } from '../../src/main/agentSkill'

const context = { settingsPath: '/home/taro/.ferret/settings.json', schemaPath: '/home/taro/.ferret/settings.schema.json', version: '9.9.9' }

describe('Ferret の設定を変える skill の中身', () => {
  const text = renderAgentSkill(context)

  it('Claude Code・Codex が読む SKILL.md の形（name・description の前書き）で、Ferret が書いた印がある', () => {
    expect(text.startsWith(`---\nname: ${AGENT_SKILL_NAME}\ndescription: `)).toBe(true)
    expect(isFerretSkill(text)).toBe(true)
    expect(isFerretSkill('---\nname: ferret-settings\n---\nmine')).toBe(false)
    expect(text).toContain(SKILL_MARKER)
  })

  it('この Ferret の設定ファイルとスキーマの場所を書く', () => {
    expect(text).toContain('`/home/taro/.ferret/settings.json`')
    expect(text).toContain('`/home/taro/.ferret/settings.schema.json`')
  })

  it('全体の項目はスキーマの上の階層のキーすべて（projects・状態・$schema を除く）。設定の項目が増えれば skill にも出る', () => {
    const top = Object.keys(SETTINGS_SCHEMA.properties!).filter((k) => !['$schema', 'projects', 'folderPath', 'url', 'viewport', 'activeProjectId', 'starPrompt'].includes(k))
    for (const key of top) expect(text).toContain(`| \`${key}\` |`)
    expect(text).not.toContain('| `projects` |')
    const extra = renderAgentSkill({ ...context, schema: { ...SETTINGS_SCHEMA, properties: { ...SETTINGS_SCHEMA.properties, brandNewKey: { type: 'boolean', description: 'A new thing.' } } } })
    expect(extra).toContain('| `brandNewKey` | boolean | A new thing. |')
  })

  it('プロジェクトの項目と確認先（URL・起動コマンド・ウインドウ）を、プロジェクトの範囲として分けて書く', () => {
    expect(text).toContain('### Project scope')
    for (const key of ['name', 'kind', 'folderPath']) expect(text).toContain(`| \`projects[].${key}\` |`)
    for (const key of ['url', 'launchCommand', 'windowMatch', 'purpose']) expect(text).toContain(`| \`projects[].urls[].${key}\` |`)
    expect(text).toContain('Decide the scope first')
  })

  it('キーを設定ファイルに書かせない', () => {
    expect(text).toMatch(/Do not write API keys into the file/)
  })
})

describe('skill を入れる・合わせる', () => {
  let home: string
  const where = () => ({ env: {}, home })
  const claudePath = () => agentSkillPath('claude', {}, home, join)
  const codexPath = () => agentSkillPath('codex', {}, home, join)

  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'ferret-skill-')) })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  it('CLAUDE_CONFIG_DIR・CODEX_HOME があればそちらに置く', () => {
    expect(agentSkillPath('claude', { CLAUDE_CONFIG_DIR: '/x/claude' }, '/h', posix.join)).toBe('/x/claude/skills/ferret-settings/SKILL.md')
    expect(agentSkillPath('codex', { CODEX_HOME: '/x/codex' }, '/h', posix.join)).toBe('/x/codex/skills/ferret-settings/SKILL.md')
    expect(agentSkillPath('codex', {}, '/h', posix.join)).toBe('/h/.codex/skills/ferret-settings/SKILL.md')
  })

  it('使っている Agent（設定のフォルダがある）にだけ入れる。どれも無ければ Claude Code に入れる', async () => {
    await mkdir(join(home, '.codex'))
    const after = await installAgentSkill(context, undefined, where())
    expect(after.find((s) => s.agent === 'codex')).toMatchObject({ installed: true, upToDate: true })
    expect(after.find((s) => s.agent === 'claude')).toMatchObject({ installed: false })

    const empty = await mkdtemp(join(tmpdir(), 'ferret-skill-empty-'))
    try {
      const fresh = await installAgentSkill(context, undefined, { env: {}, home: empty })
      expect(fresh.find((s) => s.agent === 'claude')?.installed).toBe(true)
    } finally { await rm(empty, { recursive: true, force: true }) }
  })

  it('同じ名前で Ferret のものでない skill は上書きしない', async () => {
    await mkdir(join(home, '.claude', 'skills', 'ferret-settings'), { recursive: true })
    await writeFile(claudePath(), 'my own skill')
    const after = await installAgentSkill(context, ['claude'], where())
    expect(after.find((s) => s.agent === 'claude')).toMatchObject({ installed: false, foreign: true })
    expect(await readFile(claudePath(), 'utf8')).toBe('my own skill')
  })

  it('リンクを通しては書かない（別の場所のファイルを書き換えさせない）', async () => {
    const outside = join(home, 'outside.md')
    await writeFile(outside, 'outside')
    await mkdir(join(home, '.claude', 'skills', 'ferret-settings'), { recursive: true })
    await symlink(outside, claudePath())
    const after = await installAgentSkill(context, ['claude'], where())
    expect(after.find((s) => s.agent === 'claude')?.foreign).toBe(true)
    expect(await readFile(outside, 'utf8')).toBe('outside')
  })

  it('起動時は、入れてある Ferret の skill だけを今の設定の項目と置き場所に合わせる。入れていない Agent には足さない', async () => {
    await mkdir(join(home, '.claude'))
    await mkdir(join(home, '.codex'))
    await installAgentSkill(context, ['claude'], where())
    const moved = { ...context, settingsPath: '/elsewhere/settings.json', version: '10.0.0' }
    expect(await syncAgentSkill(moved, where())).toBe(1)
    expect(await readFile(claudePath(), 'utf8')).toContain('/elsewhere/settings.json')
    expect((await agentSkillStatus(moved, where())).find((s) => s.agent === 'codex')?.installed).toBe(false)
    await expect(readFile(codexPath(), 'utf8')).rejects.toThrow()
    // 同じ中身なら書き直さない
    expect(await syncAgentSkill(moved, where())).toBe(0)
  })
})
