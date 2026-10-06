import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { googleFileUrl, isGoogleFile } from '@shared/googleFiles'
import { readOfficeFile } from '../../src/main/projectMedia'

describe('Google ドライブのショートカット（@shared/googleFiles）', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123456789'

  it('種類ごとの編集画面の URL にする', () => {
    expect(isGoogleFile('Drive/計画.gdoc')).toBe(true)
    expect(isGoogleFile('a.GSHEET')).toBe(true)
    expect(isGoogleFile('a.docx')).toBe(false)
    expect(googleFileUrl('a.gdoc', JSON.stringify({ doc_id: id }))).toBe(`https://docs.google.com/document/d/${id}/edit`)
    expect(googleFileUrl('a.gsheet', JSON.stringify({ doc_id: id }))).toBe(`https://docs.google.com/spreadsheets/d/${id}/edit`)
    expect(googleFileUrl('a.gslides', JSON.stringify({ doc_id: id }))).toBe(`https://docs.google.com/presentation/d/${id}/edit`)
    expect(googleFileUrl('a.gmap', JSON.stringify({ doc_id: id }))).toBe(`https://drive.google.com/open?id=${id}`)
  })

  it('resource_key とアカウントを付ける', () => {
    const url = googleFileUrl('a.gdoc', JSON.stringify({ '': 'WARNING!', doc_id: id, resource_key: '0-abc', email: 'taro@example.com' }))
    expect(url).toBe(`https://docs.google.com/document/d/${id}/edit?resourcekey=0-abc&authuser=taro%40example.com`)
  })

  it('古い版の url から id を取り出す。Google 以外のホストは使わない', () => {
    expect(googleFileUrl('a.gsheet', JSON.stringify({ url: `https://docs.google.com/open?id=${id}` }))).toBe(`https://docs.google.com/spreadsheets/d/${id}/edit`)
    expect(googleFileUrl('a.gdoc', JSON.stringify({ url: `https://docs.google.com/document/d/${id}/edit` }))).toBe(`https://docs.google.com/document/d/${id}/edit`)
    expect(googleFileUrl('a.gdoc', JSON.stringify({ url: `https://evil.example/open?id=${id}` }))).toBeNull()
    expect(googleFileUrl('a.gdoc', JSON.stringify({ url: `http://docs.google.com/open?id=${id}` }))).toBeNull()
  })

  it('壊れた中身・形の違う id・怪しい値は null か付けない', () => {
    expect(googleFileUrl('a.gdoc', 'not json')).toBeNull()
    expect(googleFileUrl('a.gdoc', 'null')).toBeNull()
    expect(googleFileUrl('a.gdoc', JSON.stringify({ doc_id: '../../x?y' }))).toBeNull()
    expect(googleFileUrl('a.txt', JSON.stringify({ doc_id: id }))).toBeNull()
    expect(googleFileUrl('a.gdoc', JSON.stringify({ doc_id: id, resource_key: 'a&b=c', email: 'x@y/z' }))).toBe(`https://docs.google.com/document/d/${id}/edit`)
  })
})

describe('Office の文書の中身（fs:readOffice）', () => {
  let root: string
  let outside: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ferret-office-'))
    outside = await mkdtemp(join(tmpdir(), 'ferret-office-out-'))
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs', 'spec.docx'), Buffer.from('PK\u0003\u0004 docx'))
    await writeFile(join(root, 'notes.txt'), 'text')
    await writeFile(join(outside, 'secret.xlsx'), 'secret')
    await symlink(join(outside, 'secret.xlsx'), join(root, 'link.xlsx'))
    await mkdir(join(root, 'folder.pptx'))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('プロジェクトの中の Office の文書を全部返す', async () => {
    const bytes = await readOfficeFile(root, 'docs/spec.docx')
    expect(Buffer.from(bytes).toString()).toBe('PK\u0003\u0004 docx')
  })

  it('Office でない種類・外を指すリンク・外へ出るパス・フォルダは断る', async () => {
    await expect(readOfficeFile(root, 'notes.txt')).rejects.toThrow()
    await expect(readOfficeFile(root, 'link.xlsx')).rejects.toThrow()
    await expect(readOfficeFile(root, '../secret.xlsx')).rejects.toThrow()
    await expect(readOfficeFile(root, 'folder.pptx')).rejects.toThrow()
  })
})
