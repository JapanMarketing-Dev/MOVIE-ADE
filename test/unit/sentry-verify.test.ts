import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSentryTestKinds, SENTRY_DESTRUCTIVE_TEST_KINDS } from '../../src/shared/telemetry'
// @ts-expect-error 型の無い .mjs（tools/qa/sentry-crash-verify.mjs）
import { STAGES, parseArgs } from '../../tools/qa/sentry-crash-verify.mjs'

const root = join(__dirname, '../..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')
const stages = STAGES as Record<string, { test: string; waitMs: number; selfExit: boolean }>

describe('クラッシュが Sentry に届くかの確認（tools/qa/sentry-crash-verify.mjs）', () => {
  it('段の FERRET_SENTRY_TEST はどれもアプリが知っている名前だけ（書き間違いで何も起こさない段を作らない）', () => {
    for (const [name, stage] of Object.entries(stages)) {
      const words = stage.test.split(',').filter(Boolean)
      expect(parseSentryTestKinds(stage.test), name).toHaveLength(words.length)
    }
  })

  it('main・renderer の JS の例外と、落とす確認（renderer のクラッシュ・main の未処理の例外・main のネイティブのクラッシュ）を全部通る', () => {
    const kinds = Object.values(stages).flatMap((s) => parseSentryTestKinds(s.test))
    expect(kinds).toEqual(expect.arrayContaining(['main', 'renderer', 'crash-renderer', 'uncaught', 'crash-main']))
    // 落とす確認は SENTRY_DESTRUCTIVE_TEST_KINDS の名前（`1`/`all` では起きない）
    expect(SENTRY_DESTRUCTIVE_TEST_KINDS).toEqual(expect.arrayContaining(['crash-renderer', 'uncaught', 'crash-main']))
  })

  it('main のネイティブのクラッシュのあとに、minidump を送るふつうの起動がある', () => {
    const order = Object.keys(stages)
    expect(order.indexOf('after-crash')).toBeGreaterThan(order.indexOf('crash-main'))
    expect(stages['after-crash'].test).toBe('')
    expect(stages['crash-main'].selfExit).toBe(true)
  })

  it('知らない引数・段は本処理の前に止める', () => {
    expect(() => parseArgs(['--help'])).toThrow()
    expect(() => parseArgs(['--stages', 'js,nope'])).toThrow()
    expect(parseArgs(['--stages', 'crash-main,after-crash', '--no-sandbox'])).toMatchObject({ stages: ['crash-main', 'after-crash'], noSandbox: true })
  })

  it('verification へ送る（FORCE）・画面と許可のダイアログを出さない・送り先は既定の DSN・隔離したフォルダ', () => {
    const src = read('tools/qa/sentry-crash-verify.mjs')
    expect(src).toMatch(/FERRET_SENTRY_FORCE: '1'/)
    expect(src).toMatch(/ADE_E2E: '1'/)
    expect(src).toMatch(/ADE_SYNTHETIC_MIC: '1'/)
    expect(src).toMatch(/delete env\.FERRET_SENTRY_DSN/)
    expect(src).toMatch(/--user-data-dir=/)
    for (const name of ['HOME', 'FERRET_CONFIG_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ZDOTDIR']) expect(src).toMatch(new RegExp(`${name}: dirs\\.`))
  })

  it('プロセスの終了などの異常はスタックを付けずに送る（captureMessage だと題名が `<object>.touch` のようなフレーム名になった）', () => {
    const main = read('src/main/telemetry.ts')
    expect(main).not.toMatch(/Sentry\.captureMessage\(/)
    expect(main).toMatch(/function reportMessage[\s\S]{0,200}Sentry\.captureEvent\(\{ message, level, tags \}\)/)
  })

  it('Windows・Linux の配布物で流す workflow は手で起動するときだけ', () => {
    const yml = read('.github/workflows/sentry-verify.yml')
    expect(yml).toMatch(/^on:\n {2}workflow_dispatch:\n\n/m)
    expect(yml).toMatch(/runner: windows-latest/)
    expect(yml).toMatch(/runner: ubuntu-24\.04/)
    expect(yml.match(/node tools\/qa\/sentry-crash-verify\.mjs --app/g)).toHaveLength(2)
  })
})
