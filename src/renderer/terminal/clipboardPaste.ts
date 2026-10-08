/** 貼り付けのデータにファイル・画像があるか（Finder でコピーしたファイル・スクリーンショット）。中身は読まない */
export function hasClipboardFiles(data: Pick<DataTransfer, 'types'> | null | undefined): boolean {
  if (!data) return false
  return [...data.types].some((type) => type === 'Files' || type.startsWith('image/'))
}
