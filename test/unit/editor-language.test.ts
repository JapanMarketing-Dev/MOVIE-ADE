import { describe, expect, it } from 'vitest'
import { detectLanguage } from '../../src/renderer/editor/language'

describe('ファイル名から Monaco の言語を決める（Orca #1085 #1542 #9795 #21267 #22049 #24145 #16396 #11215 #5414）', () => {
  it.each([
    ['App.vue', 'html'], ['Page.svelte', 'html'], ['index.astro', 'html'], ['view.jsp', 'html'],
    ['MainWindow.xaml', 'xml'], ['kernel.cu', 'cpp'], ['kernel.cuh', 'cpp'],
    ['Account.cls', 'apex'], ['Lead.trigger', 'apex'],
    ['tasks.rake', 'ruby'], ['config.ru', 'ruby'], ['ferret.gemspec', 'ruby'], ['Rakefile', 'ruby'], ['Gemfile', 'ruby'],
    ['report.qmd', 'markdown'], ['analysis.Rmd', 'markdown'],
    ['prod.tfvars', 'hcl'], ['defs.svh', 'systemverilog'], ['defs.vh', 'verilog']
  ])('%s → %s', (name, language) => {
    expect(detectLanguage(`/repo/src/${name}`)).toBe(language)
  })

  it('今までの対応は変えない', () => {
    expect(detectLanguage('C:\\repo\\main.tsx')).toBe('typescript')
    expect(detectLanguage('/repo/Makefile')).toBe('plaintext')
    expect(detectLanguage('/repo/.env.local')).toBe('ini')
    expect(detectLanguage('/repo/notes.txt')).toBe('plaintext')
  })
})
