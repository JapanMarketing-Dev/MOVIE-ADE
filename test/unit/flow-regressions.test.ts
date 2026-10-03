/**
 * 録画 → 指摘 → Agentへ送信 の通し確認（tools/qa/flow-check.mjs）で見つかった不具合の回帰テスト。
 * - 公式インストーラの Claude Code（前面プロセス名が版番号）を同定できず「Start Codex or Claude Code」で送れなかった
 * - 選んでいたターミナルに Agent が居ないと送れなかった
 * - 物音に付いた「*claps*」が指摘の見出しになり、要望が空だった
 * - 話しただけの指摘に、ほぼ一色の静止画（読み込み途中の画面）が選ばれた
 */
import { describe, expect, it } from 'vitest'
import { agentForProcess, isVersionProcessName } from '../../src/shared/agentCatalog'
import { chooseSendTarget, type SendCandidate } from '../../src/main/agent/sendTarget'
import { agentInProcessTree, isShellProcess, parseProcessRows } from '../../src/main/agent/processTree'
import { dropHallucinations, isSilencePhrase, segmentDbfs, stripSoundTags } from '../../src/main/pipeline/stt/hallucination'
import { assembleFromDraft } from '../../src/main/pipeline/assemble'
import { buildDraft } from '../../src/main/pipeline/draft'
import { isNearlyBlank } from '../../src/main/recording/frames'
import type { Material, TranscriptSegment } from '../../src/main/pipeline/types'
import { meta } from './fixtures'

describe('Agent の同定（公式インストーラの Claude Code）', () => {
  it('版番号だけのプロセス名は名前では決めず、版番号の名前だと分かる', () => {
    expect(isVersionProcessName('2.1.288')).toBe(true)
    expect(isVersionProcessName('2.1.288-beta.1')).toBe(true)
    expect(isVersionProcessName('claude')).toBe(false)
    expect(isVersionProcessName('zsh')).toBe(false)
    expect(agentForProcess('2.1.288')).toBeNull()
  })

  it('コマンド行（ps の args）なら claude と分かる。実体のパスでも分かる', () => {
    expect(agentForProcess('claude --dangerously-skip-permissions')).toBe('claude')
    expect(agentForProcess('/Users/me/.local/bin/claude')).toBe('claude')
    expect(agentForProcess('/Users/me/.local/share/claude/versions/2.1.288 --resume x')).toBe('claude')
    expect(agentForProcess('/opt/other/versions/2.1.288')).toBeNull()
  })
})

describe('プロセスの木からの同定（起動中の Claude Code に送れなかった）', () => {
  const identify = (line: string) => agentForProcess(line)
  const SHELL = 100

  it('npm 版の Claude Code（node）が MCP サーバーとして codex を起動していても、シェルの子の claude で決める', () => {
    const rows = parseProcessRows([
      `  200   ${SHELL} node /Users/me/.nvm/versions/node/v22.2.0/bin/claude --dangerously-skip-permissions`,
      '  300   200 node /Users/me/.nvm/versions/node/v22.2.0/bin/codex mcp-server',
      '  301   200 /opt/homebrew/bin/rg --files',
      '  999     1 node /elsewhere/bin/gemini'
    ].join('\n'))
    expect(agentInProcessTree(rows, SHELL, identify)).toBe('claude')
  })

  it('process.title で引数が「claude」だけになった node 版も、公式インストーラの版番号の実体も分かる', () => {
    expect(agentInProcessTree(parseProcessRows(`200 ${SHELL} claude`), SHELL, identify)).toBe('claude')
    expect(agentInProcessTree(parseProcessRows(`200 ${SHELL} /Users/me/.local/share/claude/versions/2.1.288`), SHELL, identify)).toBe('claude')
  })

  it('ラッパーのスクリプトの下で動く Agent は1段下で見つける', () => {
    const rows = parseProcessRows([`200 ${SHELL} /bin/zsh /Users/me/bin/my-agent-wrapper`, '201 200 node /usr/local/bin/codex'].join('\n'))
    expect(agentInProcessTree(rows, SHELL, identify)).toBe('codex')
  })

  it('同じ段に別の Agent が2つあれば決めない。子が居なければ null', () => {
    const rows = parseProcessRows([`200 ${SHELL} claude`, `201 ${SHELL} codex`].join('\n'))
    expect(agentInProcessTree(rows, SHELL, identify)).toBeNull()
    expect(agentInProcessTree([], SHELL, identify)).toBeNull()
  })

  it('前面がシェルそのものなら Agent は居ない', () => {
    for (const name of ['zsh', '-zsh', '/bin/bash', 'fish', 'pwsh.exe', 'cmd.exe']) expect(isShellProcess(name), name).toBe(true)
    for (const name of ['claude', 'node', '2.1.288', 'vim']) expect(isShellProcess(name), name).toBe(false)
  })
})

describe('送信先の選び方', () => {
  const c = (id: string, kind: SendCandidate['kind'], state = 'idle', cwd = '/p'): SendCandidate => ({ id, cwd, kind, state })

  it('選んでいるターミナルに Agent が居ればそこへ送る', () => {
    expect(chooseSendTarget('t2', [c('t1', 'claude-code'), c('t2', 'codex')], '/p')).toBe('t2')
  })

  it('選んでいるのが素のシェルなら、同じプロジェクトの Agent へ送る（Claude Code を先に、待機中を先に）', () => {
    const list = [c('t1', 'unknown', 'unknown'), c('t2', 'codex'), c('t3', 'claude-code', 'working'), c('t4', 'claude-code')]
    expect(chooseSendTarget('t1', list, '/p')).toBe('t4')
  })

  it('確認待ち（blocked）は後回しにする', () => {
    expect(chooseSendTarget(null, [c('t1', 'claude-code', 'blocked'), c('t2', 'claude-code', 'idle')], '/p')).toBe('t2')
  })

  it('選んでいるターミナルが無く（null）、どれかで Agent が動いていればそこへ送る', () => {
    expect(chooseSendTarget(null, [c('t1', 'unknown', 'unknown'), c('t2', 'claude-code')], '/p')).toBe('t2')
  })

  it('ターミナルはあるが Agent が居ない・ターミナルが1つも無い ときは null（renderer が既定の Agent を起動して送り直す）', () => {
    expect(chooseSendTarget('t1', [c('t1', 'unknown', 'unknown'), c('t2', 'unknown', 'unknown')], '/p')).toBeNull()
    expect(chooseSendTarget(null, [], null)).toBeNull()
  })

  it('別のプロジェクトの Agent には送らない。どこにも居なければ null（renderer が起動する）', () => {
    expect(chooseSendTarget('t1', [c('t1', 'unknown', 'unknown'), c('t2', 'claude-code', 'idle', '/other')], '/p')).toBeNull()
    expect(chooseSendTarget('t1', [c('t2', 'claude-code', 'idle', '/p/sub')], '/p')).toBe('t2')
    expect(chooseSendTarget(null, [], '/p')).toBeNull()
  })
})

describe('文字起こしの幻覚', () => {
  const seg = (text: string, t0 = 0, t1 = 1000): TranscriptSegment => ({ t0, t1, speaker: 'self', text, source: 'mic' })

  it('効果音のタグだけの区間は話した言葉ではない', () => {
    for (const text of ['*claps*', '* Claps *', '[Music]', '(applause)', '（拍手）', '♪', '♪ la la ♪', '[BLANK_AUDIO]', '*laughs* ...']) {
      expect(stripSoundTags(text), text).toBe('')
    }
  })

  it('タグを除いた残りは残す。文の途中の丸括弧は消さない', () => {
    expect(stripSoundTags('*claps* Make the button bigger')).toBe('Make the button bigger')
    expect(stripSoundTags('Use the (primary) color')).toBe('Use the (primary) color')
  })

  it('決まり文句は、区間が静かなときだけ捨てる', async () => {
    expect(isSilencePhrase('Thank you.')).toBe(true)
    expect(isSilencePhrase('ご視聴ありがとうございました')).toBe(true)
    expect(isSilencePhrase('Thank you, now make the header blue')).toBe(false)
    const quiet = await dropHallucinations([seg('Thank you.'), seg('*claps*'), seg('Make it red')], async () => -60)
    expect(quiet.map((s) => s.text)).toEqual(['Make it red'])
    const loud = await dropHallucinations([seg('Thank you.')], async () => -20)
    expect(loud.map((s) => s.text)).toEqual(['Thank you.'])
    // 音量が分からなければ決まり文句は残す（タグは消す）
    const unknown = await dropHallucinations([seg('Thank you.'), seg('[Music]')], async () => undefined)
    expect(unknown.map((s) => s.text)).toEqual(['Thank you.'])
  })

  it('区間の音量は WAV のその範囲だけで測る', () => {
    const samples = new Int16Array(16_000 * 2)
    samples.fill(8000, 16_000) // 後半1秒だけ音がある
    expect(segmentDbfs(samples, 16_000, 5000, 5000, 6000)).toBe(-Infinity)
    expect(segmentDbfs(samples, 16_000, 5000, 6000, 7000)).toBeGreaterThan(-20)
  })
})

describe('下書きの指摘（LLM で整理する前）', () => {
  const base: Material = {
    meta,
    transcript: [{ t0: 2000, t1: 4000, speaker: 'self', text: 'Make the sign up button stand out.', source: 'mic' }],
    events: [
      { t: 0, type: 'nav', url: 'http://localhost:3000/', title: 'Top', viewport: 1280 },
      { t: 20_000, type: 'pen', id: 'p1', t_end: 21_000, bbox: [10, 10, 80, 30], el: { selector: '#signup', text: 'Sign up' } }
    ],
    frames: [
      { t: 100, path: '00001.jpeg', blank: true },
      { t: 2600, path: '00002.jpeg' },
      { t: 21_050, path: '00003.jpeg', annotationId: 'p1' }
    ]
  }

  it('要望には話した全文が入る（空の「What should change」にしない）', () => {
    const doc = assembleFromDraft(base, buildDraft(base).items)
    const spoken = doc.items.find((it) => it.quotes.length > 0)!
    expect(spoken.request).toBe('Make the sign up button stand out.')
  })

  it('話していないペンだけの指摘は、囲んだ要素を見出しにする', () => {
    const doc = assembleFromDraft(base, buildDraft(base).items)
    const pen = doc.items.find((it) => it.quotes.length === 0)!
    expect(pen.title).toBe('Pen mark at “Sign up”')
  })

  it('話しただけの指摘には、ほぼ一色の静止画を選ばない', () => {
    const early: Material = { ...base, transcript: [{ ...base.transcript[0]!, t0: 50, t1: 900 }] }
    const item = buildDraft(early).items.find((it) => it.origin === 'speech')!
    expect(item.frameTimes).toEqual([2600])
  })
})

describe('ほぼ一色の静止画', () => {
  const bitmap = (paint: (x: number, y: number) => number) => {
    const w = 32
    const h = 24
    const out = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = paint(x, y)
      out.set([v, v, v, 255], (y * w + x) * 4)
    }
    return out
  }

  it('白一色・上の帯だけの画面は一色とみなす', () => {
    expect(isNearlyBlank(bitmap(() => 255))).toBe(true)
    expect(isNearlyBlank(bitmap((x, y) => (y === 0 && x < 10 ? 30 : 255)))).toBe(true)
  })

  it('文字や部品が描かれた画面は一色ではない', () => {
    expect(isNearlyBlank(bitmap((x, y) => (y % 3 === 0 && x > 2 && x < 26 ? 40 : 250)))).toBe(false)
  })
})
