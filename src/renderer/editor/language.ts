/**
 * ファイル名から Monaco の言語 ID を決める。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/lib/language-detect.ts（MIT）
 * Orca が独自に登録している言語（vue・svelte・astro・nim・typst・jsonl など）は
 * 持ち込まないので、Monaco に最初からある言語だけに絞った。
 * monaco-editor を読み込まずに使えるよう、ここでは表だけで決める（起動を重くしない）。
 */

const EXT_TO_LANGUAGE: Record<string, string> = {
  // Monaco には typescriptreact / javascriptreact が無く、.tsx / .jsx も基本の ID で色が付く
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.cts': 'typescript',
  '.mts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.qmd': 'markdown',
  '.rmd': 'markdown',
  '.mdx': 'mdx',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  // Monaco に専用の文法が無いテンプレートは、HTML として最低限の色を付ける（Orca #1085 #1542 #9795）
  '.vue': 'html',
  '.svelte': 'html',
  '.astro': 'html',
  '.jsp': 'html',
  '.xaml': 'xml',
  '.liquid': 'liquid',
  '.twig': 'twig',
  '.hbs': 'handlebars',
  '.pug': 'pug',
  '.xml': 'xml',
  '.svg': 'xml',
  '.plist': 'xml',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cu': 'cpp',
  '.cuh': 'cpp',
  '.m': 'objective-c',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.ru': 'ruby',
  '.gemspec': 'ruby',
  '.jbuilder': 'ruby',
  '.cls': 'apex',
  '.trigger': 'apex',
  '.apex': 'apex',
  '.php': 'php',
  '.swift': 'swift',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.bat': 'bat',
  '.cmd': 'bat',
  '.ps1': 'powershell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.prisma': 'graphql',
  '.dockerfile': 'dockerfile',
  '.proto': 'proto',
  '.lua': 'lua',
  '.r': 'r',
  '.scala': 'scala',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.clj': 'clojure',
  '.sol': 'sol',
  '.sv': 'systemverilog',
  '.svh': 'systemverilog',
  '.v': 'verilog',
  '.vh': 'verilog',
  '.tf': 'hcl',
  '.tfvars': 'hcl',
  '.hcl': 'hcl',
  '.pl': 'perl',
  '.jl': 'julia',
  '.vb': 'vb',
  '.tcl': 'tcl',
  '.rst': 'restructuredtext'
}

const FILENAME_TO_LANGUAGE: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'plaintext',
  rakefile: 'ruby',
  gemfile: 'ruby',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.env': 'ini',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.profile': 'shell',
  '.zshrc': 'shell',
  '.zshenv': 'shell',
  '.zprofile': 'shell'
}

export function detectLanguage(filePath: string): string {
  const filename = filePath.split(/[\\/]/).at(-1) ?? ''
  const lower = filename.toLowerCase()
  if (Object.hasOwn(FILENAME_TO_LANGUAGE, lower)) return FILENAME_TO_LANGUAGE[lower]!
  const dot = lower.lastIndexOf('.')
  const ext = dot > 0 ? lower.slice(dot) : ''
  // .env.local などは、拡張子で決まらなければ INI として色を付ける
  return EXT_TO_LANGUAGE[ext] ?? (lower.startsWith('.env.') ? 'ini' : 'plaintext')
}

export function isMarkdownLanguage(language: string): boolean {
  return language === 'markdown' || language === 'mdx'
}
