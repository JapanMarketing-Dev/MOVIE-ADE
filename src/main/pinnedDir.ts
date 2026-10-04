/**
 * プロジェクトの中のフォルダを開いたまま持ち、その中の名前を作る・変える・消す（security-5 [11]）。
 *
 * パスの文字列で「中か」を確かめてから、あとで同じ文字列で rename・rm・mkdir すると、そのあいだに
 * プロジェクトの中のプロセス（Agent など）が途中のフォルダをリンクへ差し替え、外を変えさせられる（TOCTOU）。
 * Node には openat / renameat2 / unlinkat が無いので、変更はすべてこのモジュールを通し、開いたフォルダからの相対で行う:
 *   - Linux: フォルダを開いた fd を持ち、/proc/self/fd/<fd>/<名前> で操作する（先祖を差し替えられても、開いたフォルダの中を指す）
 *   - macOS・Windows: 操作の間だけ作業フォルダをそのフォルダへ移し（同期で。ほかの JS は割り込めない）、
 *     移った先が開いたときと同じ実体（(dev, ino)）かを確かめてから、相対の名前で操作する。
 *     作業フォルダはカーネルが実体で持つので、先祖を差し替えられても同じフォルダの中を指す
 *     （Windows は作業フォルダの中・先祖の名前を変えられない）
 *   - 書くファイルは相対で O_EXCL で作ってから、実体のパスで開き直し、開いたものが作ったものと同じかを確かめる（containedFile.ts と同じ形）
 *   - 名前の変更は上書きしない（先の名前を O_EXCL / mkdir で押さえてから、押さえたものだけを置き換える）
 *   - フォルダごと消すときは、まず同じ親の中で隔離用の名前へ動かし、動かしたものが確かめたものと同じ実体のときだけ、
 *     その中を1つずつ（各フォルダを開いて確かめながら）消す
 *   - 別のフォルダへの移動（macOS・Windows）とゴミ箱（OS はパスでしか受け取らない）は、同期で先を確かめた直後に行い、
 *     終わったあとで先にあるのが元の実体かを確かめる（違えば戻して断る）
 * 確かめられない・食い違うときは操作せずに断る（OutsideProjectError）。
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, type BigIntStats } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { t } from '@shared/i18n'

const O_DIRECTORY = (constants as { O_DIRECTORY?: number }).O_DIRECTORY ?? 0
const O_NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
const O_NONBLOCK = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0
/** 開いたフォルダの fd からパスを作れるか（Linux の /proc） */
const PROC_FD = process.platform === 'linux' && existsSync('/proc/self/fd')

/** 確かめたフォルダが外を指している・別のものに差し替えられた */
export class OutsideProjectError extends Error {
  constructor() {
    super(t('files.errors.outside'))
    this.name = 'OutsideProjectError'
  }
}

export interface Identity { dev: bigint; ino: bigint }

const sameEntry = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino

function inside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

function leaf(name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) throw new OutsideProjectError()
  return name
}

const errno = (code: string, name: string) => Object.assign(new Error(`${code}: ${name}`), { code })

/** プロジェクトの中のフォルダを開いて持つ。close するまで、その実体の中だけを操作する */
export class PinnedDir {
  private constructor(
    private readonly root: string,
    /** 開いたときの実体のパス */
    readonly real: string,
    private readonly fd: number | null,
    readonly id: Identity
  ) {}

  /** dir（プロジェクトの中のフォルダ）を開いて持つ。外・フォルダでない・開いたものと食い違うなら断る。無ければ ENOENT */
  static async open(root: string, dir: string): Promise<PinnedDir> {
    const [realRoot, real] = await Promise.all([realpath(root), realpath(dir)])
    if (!inside(realRoot, real)) throw new OutsideProjectError()
    // Linux はフォルダを開いた fd を持つ（/proc/self/fd から操作する）。ほかの OS は実体の (dev, ino) を持って、操作のたびに作業フォルダで確かめる
    const fd = PROC_FD ? openSync(real, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK) : null
    let pinned: PinnedDir
    try {
      const st = fd !== null ? fstatSync(fd, { bigint: true }) : await stat(real, { bigint: true })
      if (!st.isDirectory()) throw new OutsideProjectError()
      pinned = new PinnedDir(root, real, fd, { dev: st.dev, ino: st.ino })
    } catch (err) {
      if (fd !== null) closeSync(fd)
      throw err
    }
    try {
      pinned.verifySync()
    } catch (err) {
      pinned.close()
      throw err
    }
    return pinned
  }

  /**
   * このフォルダの中で fn を同期で行う。fn には中の名前を「このフォルダからの」パスにする関数を渡す
   * （Linux は /proc/self/fd、ほかは作業フォルダをここへ移して相対の名前）
   */
  within<T>(fn: (at: (name: string) => string, self: string) => T): T {
    if (PROC_FD && this.fd !== null) return fn((name) => `/proc/self/fd/${this.fd}/${leaf(name)}`, `/proc/self/fd/${this.fd}`)
    const prev = process.cwd()
    process.chdir(this.real)
    try {
      // 移った先（カーネルが持つ実体）が開いたときのフォルダか
      if (!sameEntry(statSync('.', { bigint: true }), this.id)) throw new OutsideProjectError()
      return fn((name) => `.${path.sep}${leaf(name)}`, '.')
    } finally {
      try { process.chdir(prev) } catch { /* 元の作業フォルダが消えた（想定内。次の操作も絶対パスで行う） */ }
    }
  }

  /** いまも開いたときと同じ実体で、同じパスにあり、プロジェクトの実体の中か（同期）。違えば OutsideProjectError */
  verifySync(): void {
    let realRoot: string, now: string
    try {
      realRoot = realpathSync.native(this.root)
      now = realpathSync.native(this.real)
    } catch {
      throw new OutsideProjectError()
    }
    if (now !== this.real || !inside(realRoot, now)) throw new OutsideProjectError()
    let st: BigIntStats
    try { st = statSync(now, { bigint: true }) } catch { throw new OutsideProjectError() }
    if (!sameEntry(st, this.id)) throw new OutsideProjectError()
  }

  async verify(): Promise<void> {
    this.verifySync()
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd)
  }
}

/** dir を開いて持ち、fn のあとで閉じる */
export async function withPinnedDir<T>(root: string, dir: string, fn: (pin: PinnedDir) => Promise<T>): Promise<T> {
  const pin = await PinnedDir.open(root, dir)
  try {
    return await fn(pin)
  } finally {
    pin.close()
  }
}

type Entry = Identity & { isDirectory: boolean; isSymbolicLink: boolean; isFile: boolean }

function entryOf(st: BigIntStats): Entry {
  return { dev: st.dev, ino: st.ino, isDirectory: st.isDirectory(), isSymbolicLink: st.isSymbolicLink(), isFile: st.isFile() }
}

function lstatAt(at: (name: string) => string, name: string): Entry | null {
  try {
    return entryOf(lstatSync(at(name), { bigint: true }))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** 名前の実体（リンクは辿らない）。無ければ null */
export async function entryIdentity(pin: PinnedDir, name: string): Promise<Entry | null> {
  return pin.within((at) => lstatAt(at, name))
}

/** 空のフォルダを作る（既にあれば EEXIST） */
export async function mkdirIn(pin: PinnedDir, name: string): Promise<void> {
  pin.within((at) => mkdirSync(at(name)))
}

/** 相対で作った・確かめたファイルを、実体のパスで開き直し、同じものかを確かめる */
async function reopen(pin: PinnedDir, name: string, flags: number, expected: Identity): Promise<FileHandle> {
  const handle = await open(path.join(pin.real, name), flags | O_NOFOLLOW | O_NONBLOCK)
  try {
    const st = await handle.stat({ bigint: true })
    if (!sameEntry(st, expected)) throw new OutsideProjectError()
    return handle
  } catch (err) {
    await handle.close()
    throw err
  }
}

/** まだ無いファイルを作って開く（O_EXCL・O_NOFOLLOW。既にあれば EEXIST）。開いたものが作ったものと同じ実体かも確かめる */
export async function createFileIn(pin: PinnedDir, name: string, mode = 0o666): Promise<FileHandle> {
  const created = pin.within((at) => {
    const fd = openSync(at(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW | O_NONBLOCK, mode)
    try { return fstatSync(fd, { bigint: true }) } finally { closeSync(fd) }
  })
  return reopen(pin, name, constants.O_WRONLY, created)
}

/** 追記するために開く（無ければ作る）。リンク・ハードリンク・ファイルでないものは断る */
export async function openAppendIn(pin: PinnedDir, name: string, mode = 0o644): Promise<FileHandle> {
  const found = pin.within((at) => {
    const fd = openSync(at(name), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | O_NOFOLLOW | O_NONBLOCK, mode)
    try { return fstatSync(fd, { bigint: true }) } finally { closeSync(fd) }
  })
  if (!found.isFile() || found.nlink > 1n) throw new OutsideProjectError()
  return reopen(pin, name, constants.O_WRONLY | constants.O_APPEND, found)
}

/** シンボリックリンクを作る（リンク先は辿らない） */
export async function symlinkIn(pin: PinnedDir, name: string, linkTarget: string): Promise<void> {
  pin.within((at) => symlinkSync(linkTarget, at(name)))
}

/** 先の名前を押さえる（ファイルは O_EXCL、フォルダは mkdir。既にあれば EEXIST）。押さえたものの実体を返す */
function reserve(at: (name: string) => string, name: string, directory: boolean): Entry | null {
  if (directory && process.platform === 'win32') {
    // Windows の rename はフォルダを既にある名前へ動かさない（そのまま失敗する）。押さえずに、あれば断る
    if (lstatAt(at, name)) throw errno('EEXIST', name)
    return null
  }
  if (directory) mkdirSync(at(name))
  else closeSync(openSync(at(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW | O_NONBLOCK, 0o600))
  return lstatAt(at, name)
}

/** 押さえた名前を戻す（押さえたものがそのまま残っているときだけ） */
function unreserve(at: (name: string) => string, name: string, reserved: Entry | null): void {
  if (!reserved) return
  const now = lstatAt(at, name)
  if (!now || !sameEntry(now, reserved)) return
  try { (now.isDirectory ? rmdirSync : unlinkSync)(at(name)) } catch { /* 片付けられなくても、元の失敗を返す */ }
}

/**
 * from の中の fromName を、to の中の toName へ動かす。
 * replace が無ければ上書きしない: 先の名前を自分で押さえ、押さえたものだけを置き換える。
 * expect を渡すと、動かすものがその実体のときだけ動かす。動かしたあとで、先にあるのが元と同じ実体かを確かめる
 */
export async function renameIn(from: PinnedDir, fromName: string, to: PinnedDir, toName: string, opt: { replace?: boolean; expect?: Identity } = {}): Promise<void> {
  const sameDir = from === to || sameEntry(from.id, to.id)
  if (sameDir || (PROC_FD && from !== to)) {
    // 同じフォルダ（どの OS でも相対で）・Linux（/proc で両方とも開いたフォルダから）
    const run = (fromAt: (name: string) => string, toAt: (name: string) => string) => {
      const source = lstatAt(fromAt, fromName)
      if (!source) throw errno('ENOENT', fromName)
      if (opt.expect && !sameEntry(source, opt.expect)) throw new OutsideProjectError()
      const reserved = opt.replace ? null : reserve(toAt, toName, source.isDirectory)
      try {
        renameSync(fromAt(fromName), toAt(toName))
      } catch (err) {
        unreserve(toAt, toName, reserved)
        throw err
      }
      const moved = lstatAt(toAt, toName)
      if (!moved || !sameEntry(moved, source)) throw new OutsideProjectError()
    }
    if (sameDir) from.within((at) => run(at, at))
    else from.within((fromAt) => to.within((toAt) => run(fromAt, toAt)))
    return
  }
  // macOS・Windows の別のフォルダへの移動: 元は作業フォルダから相対、先は同期で確かめた直後の実体のパス
  const source = await entryIdentity(from, fromName)
  if (!source) throw errno('ENOENT', fromName)
  if (opt.expect && !sameEntry(source, opt.expect)) throw new OutsideProjectError()
  const reserved = opt.replace ? null : to.within((at) => reserve(at, toName, source.isDirectory))
  const target = path.join(to.real, leaf(toName))
  try {
    from.within((at) => {
      to.verifySync()
      renameSync(at(fromName), target)
    })
  } catch (err) {
    to.within((at) => unreserve(at, toName, reserved))
    throw err
  }
  const moved = await entryIdentity(to, toName)
  if (!moved || !sameEntry(moved, source)) {
    // 先が差し替えられていた。動かしたものを元へ戻して断る
    from.within((at) => { try { renameSync(target, at(fromName)) } catch { /* 戻せなくても断る */ } })
    throw new OutsideProjectError()
  }
}

/**
 * pin の中の name を消す。ファイル・リンクはそのもの（リンク先は消さない）。フォルダは recursive のときだけ中ごと:
 * 同じ親の中で隔離用の名前へ動かし、動かしたものが確かめた実体なら、その中を1つずつ確かめながら消す。
 * expect を渡すと、その実体のときだけ消す。無ければ何もしない
 */
export async function removeIn(pin: PinnedDir, name: string, opt: { recursive?: boolean; expect?: Identity } = {}): Promise<void> {
  const entry = await entryIdentity(pin, name)
  if (!entry) return
  if (opt.expect && !sameEntry(entry, opt.expect)) throw new OutsideProjectError()
  if (!entry.isDirectory) {
    pin.within((at) => {
      const now = lstatAt(at, name)
      if (now && sameEntry(now, entry)) unlinkSync(at(name))
    })
    return
  }
  if (!opt.recursive) {
    pin.within((at) => rmdirSync(at(name)))
    return
  }
  const quarantine = `.ferret-removing-${randomBytes(6).toString('hex')}`
  await renameIn(pin, name, pin, quarantine, { replace: false, expect: entry })
  await removeTree(pin, quarantine)
}

/** 隔離したフォルダの中身を、各フォルダを開いて確かめながら消す */
async function removeTree(parent: PinnedDir, name: string): Promise<void> {
  const expected = await entryIdentity(parent, name)
  if (!expected?.isDirectory) return
  const dir = await PinnedDir.open(parent.real, path.join(parent.real, name))
  try {
    if (!sameEntry(dir.id, expected)) throw new OutsideProjectError()
    const children = dir.within((_at, self) => readdirSync(self))
    for (const child of children) {
      const st = await entryIdentity(dir, child)
      if (!st) continue
      if (st.isDirectory) await removeTree(dir, child)
      else dir.within((at) => unlinkSync(at(child)))
    }
  } finally {
    dir.close()
  }
  parent.within((at) => {
    const now = lstatAt(at, name)
    if (now && sameEntry(now, expected)) rmdirSync(at(name))
  })
}

/**
 * ゴミ箱へ送る。OS のゴミ箱はパスでしか受け取らないので、確かめた実体のパスで渡し、直前と直後に親を確かめる
 * （ゴミ箱へ送ったものは元に戻せる）。expect を渡すと、その実体のときだけ送る
 */
export async function trashIn(pin: PinnedDir, name: string, trash: (absolute: string) => Promise<void>, expect?: Identity): Promise<void> {
  const entry = await entryIdentity(pin, name)
  if (!entry) throw errno('ENOENT', name)
  if (expect && !sameEntry(entry, expect)) throw new OutsideProjectError()
  pin.verifySync()
  await trash(path.join(pin.real, leaf(name)))
  pin.verifySync()
}
