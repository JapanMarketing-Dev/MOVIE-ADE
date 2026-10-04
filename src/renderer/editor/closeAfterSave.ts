/**
 * 「保存して閉じる」で、保存が終わったあとにタブを閉じてよいか（純粋な関数。単体テストの対象）。
 *
 * 確認を閉じてから書き込むので、書き込み中にも打てる。その分は保存されておらず、閉じると消える（Orca #20482）。
 * 書いた内容と今の編集中の内容が同じとき（編集中の写しが無いときも）だけ閉じる。違えばタブを残し、変更ありのままにする
 */
export function canCloseAfterSave(written: string | undefined, current: string | undefined): boolean {
  return current === undefined || current === written
}
