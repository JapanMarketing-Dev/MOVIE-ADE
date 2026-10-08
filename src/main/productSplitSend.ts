import { itemList, splitByProduct, type SplitProject } from '@shared/productSplit'

/**
 * 全体（すべてのプロダクト）で録った1回のフィードバックを、指摘のページの URL でプロダクトごとに分けて送る（@shared/productSplit）。
 * - そのプロダクトに Agent が動いていれば、その Agent へ直接（そのプロダクトの番号だけを直すよう添える）
 * - 残り（Agent の居ないプロダクト・決まらなかった指摘）は全体の Agent へ、プロダクトごとの subagent に並行して任せるよう添える
 * どれも同時に送る。プロダクトが1つも決まらなければ null（呼び出し側がふつうの送信に任せる）。
 * Electron に依存しない（送り先の探し方と送り方は deps で受け取る。src/main/index.ts の review:send が使う）
 */

export interface SplitSendDeps {
  /** そのフォルダで動いている Agent のターミナル（無ければ null） */
  resolveTarget: (folder: string) => Promise<string | null>
  send: (terminalId: string, text: string) => Promise<{ ok: boolean; message: string }>
  t: (key: string, values?: Record<string, string | number>) => string
}

export interface SplitSendItem {
  id: string
  index: number
  t: number
  include: boolean
  context: { url?: string }
}

export async function sendSplitByProduct(
  deps: SplitSendDeps,
  input: {
    products: ReadonlyArray<SplitProject>
    items: ReadonlyArray<SplitSendItem>
    /** 送る（未対応の）指摘の id */
    pending: ReadonlySet<string>
    /** 全体のフォルダ（全体の Agent の居場所） */
    orchestraFolder: string | null
    /** 送る本文（feedback.md を読ませる指示） */
    instruction: string
    feedbackPath: string
  }
): Promise<{ ok: boolean; message: string; terminalId?: string } | null> {
  const shares = splitByProduct(input.products, input.items.filter((it) => it.include && input.pending.has(it.id)).map((it) => ({ index: it.index, t: it.t, url: it.context.url })))
  if (!shares.some((s) => s.projectId)) return null
  const direct: Array<{ name: string; indexes: number[]; terminalId: string }> = []
  const relay: Array<{ name: string; path: string; indexes: number[] }> = []
  const unknown: number[] = []
  for (const share of shares) {
    const product = input.products.find((p) => p.id === share.projectId)
    if (!product) { unknown.push(...share.indexes); continue }
    const id = await deps.resolveTarget(product.folderPath)
    if (id) direct.push({ name: product.name, indexes: share.indexes, terminalId: id })
    else relay.push({ name: product.name, path: product.folderPath, indexes: share.indexes })
  }
  const jobs: Array<Promise<{ ok: boolean; message: string; terminalId: string }>> = direct.map(async (d) => ({
    ...(await deps.send(d.terminalId, `${input.instruction}\n\n${deps.t('orchestra.splitDirectNote', { name: d.name, items: itemList(d.indexes), path: input.feedbackPath })}`)),
    terminalId: d.terminalId
  }))
  if (relay.length || unknown.length) {
    const top = input.orchestraFolder ? await deps.resolveTarget(input.orchestraFolder) : null
    if (top) {
      const lines = [
        ...relay.map((r) => deps.t('orchestra.splitRelayLine', { name: r.name, path: r.path, items: itemList(r.indexes) })),
        ...direct.map((d) => deps.t('orchestra.splitDoneLine', { name: d.name, items: itemList(d.indexes) })),
        ...(unknown.length ? [deps.t('orchestra.splitUnknownLine', { items: itemList(unknown) })] : [])
      ]
      jobs.push(deps.send(top, `${input.instruction}\n\n${deps.t('orchestra.splitRelayNote')}\n${lines.join('\n')}`).then((r) => ({ ...r, terminalId: top })))
    } else if (!direct.length) {
      return { ok: false, message: deps.t('terminal.send.noAgent') }
    }
  }
  const results = await Promise.all(jobs)
  const failed = results.filter((r) => !r.ok)
  return failed.length
    ? { ok: results.length > failed.length, message: failed.map((r) => r.message).join(' / '), terminalId: results[0]?.terminalId }
    : { ok: true, message: deps.t('orchestra.splitSent', { count: results.length }), terminalId: results[0]?.terminalId }
}
