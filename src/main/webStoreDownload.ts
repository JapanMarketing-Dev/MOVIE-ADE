/**
 * Chrome ウェブストアから拡張のパッケージを取る（browserExtensions.ts の installFromWebStore が使う）。
 *
 * Electron の net.fetch はリダイレクトの後の行き先（Response.url）を返さないので、net.request でリダイレクトを1回ずつ受け、
 * そのたびに行き先が https の Google の配布の置き場（isWebStoreDownloadHost）かを確かめてから進む。ほかへは行かない。
 * 本文は上限まで読む。中身が本物かは、このあと crx.ts が署名と ID で確かめる。
 */
import { net } from 'electron'
import { isWebStoreDownloadHost } from '@shared/browserExtensions'

const MAX_REDIRECTS = 5
const TIMEOUT_MS = 60_000

export interface StoreDownload {
  status: number
  body: Uint8Array
}

function allowed(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && isWebStoreDownloadHost(u.hostname)
  } catch {
    return false
  }
}

export function downloadFromWebStore(url: string, maxBytes: number): Promise<StoreDownload> {
  return new Promise((resolve, reject) => {
    if (!allowed(url)) {
      reject(new Error('not a Chrome Web Store download address'))
      return
    }
    let redirects = 0
    let settled = false
    const request = net.request({ url, redirect: 'manual', useSessionCookies: false })
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.abort()
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error('the Chrome Web Store did not answer in time')), TIMEOUT_MS)
    request.on('redirect', (_status, _method, redirectUrl) => {
      redirects += 1
      if (redirects > MAX_REDIRECTS || !allowed(redirectUrl)) {
        fail(new Error('the Chrome Web Store sent the package from an unexpected place'))
        return
      }
      request.followRedirect()
    })
    request.on('response', (response) => {
      const chunks: Buffer[] = []
      let total = 0
      response.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > maxBytes) {
          fail(new Error('the extension package is too large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ status: response.statusCode, body: new Uint8Array(Buffer.concat(chunks)) })
      })
      response.on('error', (err: Error) => fail(err))
    })
    request.on('error', (err) => fail(err))
    request.end()
  })
}
