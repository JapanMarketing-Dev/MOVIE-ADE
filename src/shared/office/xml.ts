/**
 * Office の XML を木にする小さな読み取り（純粋な関数。DOMParser の無い Node の単体テストでも同じに動く）。
 *
 * 要素は接頭辞を外した名前（w:p → p）で持ち、属性は書いてあるとおりの名前（r:embed）で持つ。
 * DTD・外部の実体は読まない（中身を展開しない）。文字の実体は &lt; などの決まったものと数値だけを戻す。
 */

export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  /** 直下の文字（要素の間の文字はつないだもの） */
  text: string
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[body] ?? whole
  })
}

function localName(qname: string): string {
  const colon = qname.indexOf(':')
  return colon >= 0 ? qname.slice(colon + 1) : qname
}

/** タグの終わりの `>`（引用符の中の `>` は飛ばす） */
function tagEnd(source: string, from: number): number {
  let quote = ''
  for (let i = from; i < source.length; i += 1) {
    const c = source[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g

export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let i = 0
  const len = source.length
  while (i < len) {
    const lt = source.indexOf('<', i)
    const textEnd = lt === -1 ? len : lt
    if (textEnd > i) {
      const top = stack[stack.length - 1]!
      if (top !== root) top.text += decodeEntities(source.slice(i, textEnd))
    }
    if (lt === -1) break
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      i = end === -1 ? len : end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9)
      const top = stack[stack.length - 1]!
      if (top !== root) top.text += source.slice(lt + 9, end === -1 ? len : end)
      i = end === -1 ? len : end + 3
      continue
    }
    if (source[lt + 1] === '?' || source[lt + 1] === '!') {
      const end = source.indexOf('>', lt + 2)
      i = end === -1 ? len : end + 1
      continue
    }
    const gt = tagEnd(source, lt + 1)
    if (gt === -1) break
    const body = source.slice(lt + 1, gt)
    i = gt + 1
    if (body[0] === '/') {
      const name = localName(body.slice(1).trim())
      // 対応の取れない閉じタグは、開いた要素の中で同じ名前のところまで閉じる（壊れた XML でも読めるだけ読む）
      for (let s = stack.length - 1; s > 0; s -= 1) {
        if (stack[s]!.name === name) {
          stack.length = s
          break
        }
      }
      continue
    }
    const selfClosing = body.endsWith('/')
    const inner = selfClosing ? body.slice(0, -1) : body
    const space = inner.search(/\s/)
    const qname = space === -1 ? inner : inner.slice(0, space)
    const attrs: Record<string, string> = {}
    if (space !== -1) {
      ATTR.lastIndex = 0
      const rest = inner.slice(space)
      let m: RegExpExecArray | null
      while ((m = ATTR.exec(rest))) attrs[m[1]!] = decodeEntities(m[3] ?? m[4] ?? '')
    }
    const node: XmlNode = { name: localName(qname), attrs, children: [], text: '' }
    stack[stack.length - 1]!.children.push(node)
    if (!selfClosing) stack.push(node)
  }
  return root
}

/** 直下の子で、名前が name のもの */
export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name)
}

export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : []
}

/** 子・孫をたどる（path の順に最初に見つかったもの） */
export function path(node: XmlNode | undefined, ...names: string[]): XmlNode | undefined {
  let current = node
  for (const name of names) current = child(current, name)
  return current
}

/** 子孫を深さ優先で全部（自分は含まない） */
export function descendants(node: XmlNode | undefined, name: string, out: XmlNode[] = []): XmlNode[] {
  if (!node) return out
  for (const c of node.children) {
    if (c.name === name) out.push(c)
    descendants(c, name, out)
  }
  return out
}

/** 属性を接頭辞を外した名前で探す（w:val と val のどちらでも） */
export function attr(node: XmlNode | undefined, name: string): string | undefined {
  if (!node) return undefined
  if (name in node.attrs) return node.attrs[name]
  for (const key of Object.keys(node.attrs)) {
    if (localName(key) === name) return node.attrs[key]
  }
  return undefined
}

/** 文書の一番上の要素 */
export function documentElement(root: XmlNode): XmlNode | undefined {
  return root.children[0]
}

/** rels（Relationship の一覧）を Id → { type, target, external } に */
export function parseRels(source: string | null): Map<string, { type: string; target: string; external: boolean }> {
  const map = new Map<string, { type: string; target: string; external: boolean }>()
  if (!source) return map
  const rels = documentElement(parseXml(source))
  for (const r of children(rels, 'Relationship')) {
    const id = r.attrs.Id
    const target = r.attrs.Target
    if (!id || target === undefined) continue
    map.set(id, { type: r.attrs.Type ?? '', target, external: r.attrs.TargetMode === 'External' })
  }
  return map
}

/** HTML の文字として安全に */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'))
}
