import { describe, expect, it, vi } from 'vitest'
import { compareAppVersions, githubRepoOf, isValidAppVersion, pickAppVersion } from '@shared/appVersion'
import pkg from '../../package.json'

// settings.ts は electron の app を読み込むので、保存先だけを差し替える
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-test' } }))
const { sanitize } = await import('../../src/main/settings')

describe('sanitize の layout（以前の terminalDock からの引き継ぎ）', () => {
  it('以前の terminalDock: bottom はターミナルの置き場所として引き継ぐ', () => {
    const s = sanitize({ terminalDock: 'bottom' })
    expect(s.layout?.panels.terminal.dock).toBe('bottom')
    // 引き継いだあとは古い項目を書かない
    expect('terminalDock' in s).toBe(false)
  })

  it('layout があれば terminalDock より優先する', () => {
    expect(sanitize({ terminalDock: 'bottom', layout: { panels: { terminal: { dock: 'left', visible: false } } } }).layout?.panels.terminal)
      .toEqual({ dock: 'left', visible: false })
  })

  it('未指定・壊れた値は既定（右・表示）', () => {
    expect(sanitize({}).layout?.panels.terminal).toEqual({ dock: 'right', visible: true })
    expect(sanitize({ terminalDock: 'left' }).layout?.panels.terminal.dock).toBe('left')
    expect(sanitize({ terminalDock: 1 }).layout?.panels.terminal.dock).toBe('right')
    expect(sanitize(null).layout?.panels.terminal.dock ?? 'right').toBe('right')
  })

  it('分割比とは独立して保存される', () => {
    const s = sanitize({ terminalDock: 'bottom', splitRatio: 0.4 })
    expect(s.splitRatio).toBe(0.4)
    expect(s.layout?.panels.terminal.dock).toBe('bottom')
  })
})

describe('compareAppVersions', () => {
  it('番号の大小を数として比べる', () => {
    expect(compareAppVersions('0.2.0', '0.1.0')).toBeGreaterThan(0)
    expect(compareAppVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareAppVersions('0.1.9', '0.1.10')).toBeLessThan(0)
    expect(compareAppVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
  })

  it('タグの v は無視する', () => {
    expect(compareAppVersions('v0.1.0', '0.1.0')).toBe(0)
    expect(compareAppVersions('V0.2.0', 'v0.1.0')).toBeGreaterThan(0)
  })

  it('プレリリースは同じ番号の正式版より古い', () => {
    expect(compareAppVersions('0.2.0-beta.1', '0.2.0')).toBeLessThan(0)
    expect(compareAppVersions('0.2.0-beta.2', '0.2.0-beta.10')).toBeLessThan(0)
    expect(compareAppVersions('0.2.0-beta.1', '0.1.0')).toBeGreaterThan(0)
  })

  it('読めない値は 0（更新ありと誤って出さない）', () => {
    expect(compareAppVersions('latest', '0.1.0')).toBe(0)
    expect(isValidAppVersion('latest')).toBe(false)
    expect(isValidAppVersion('v0.1.0')).toBe(true)
  })
})

describe('githubRepoOf', () => {
  it('package.json の repository の書き方を読み分ける', () => {
    expect(githubRepoOf('github:JapanMarketing-Dev/ADE-movie')).toBe('JapanMarketing-Dev/ADE-movie')
    expect(githubRepoOf('JapanMarketing-Dev/ADE-movie')).toBe('JapanMarketing-Dev/ADE-movie')
    expect(githubRepoOf({ type: 'git', url: 'https://github.com/JapanMarketing-Dev/ADE-movie.git' })).toBe('JapanMarketing-Dev/ADE-movie')
    expect(githubRepoOf('git@github.com:JapanMarketing-Dev/ADE-movie.git')).toBe('JapanMarketing-Dev/ADE-movie')
  })

  it('未設定・GitHub 以外は null（配布元が未設定）', () => {
    expect(githubRepoOf(undefined)).toBeNull()
    expect(githubRepoOf('')).toBeNull()
    expect(githubRepoOf('https://gitlab.com/a/b.git')).toBeNull()
  })
})

describe('pickAppVersion', () => {
  it('package.json の version を Electron の版より優先する（dev 起動で v44.x と出さない）', () => {
    expect(pickAppVersion('0.1.0', '44.5.1')).toBe('0.1.0')
  })
  it('先頭が読めなければ次の候補、どれも読めなければ 0.0.0', () => {
    expect(pickAppVersion(undefined, '0.2.0')).toBe('0.2.0')
    expect(pickAppVersion('', 'abc', null)).toBe('0.0.0')
    expect(pickAppVersion('v0.3.0')).toBe('0.3.0')
  })
  it('dev 起動でも、最新リリースと比べるのはアプリの版', () => {
    const current = pickAppVersion(pkg.version, '44.5.1')
    expect(current).toBe(pkg.version)
    // Electron の版で比べると、新しい版があっても「最新」と誤判定してしまう（アプリの版を上げても成り立つよう、次の minor で比べる）
    const [major, minor] = current.split('.').map(Number)
    const next = `${major}.${minor! + 1}.0`
    expect(compareAppVersions(next, current)).toBeGreaterThan(0)
    expect(compareAppVersions(next, '44.5.1')).toBeLessThan(0)
  })
  it('package.json の repository は配布元として読める', () => {
    expect(githubRepoOf(pkg.repository)).toMatch(/^[\w.-]+\/[\w.-]+$/)
  })
})
