import { ImageOff } from 'lucide-react'

/**
 * 指摘まわりの印。
 * 装飾の挿絵はやめた（空状態は短い文とボタンだけにする方針）。呼び出し側を壊さないよう名前だけ残す。
 */

export function FindingsEmptyArt() {
  return null
}

/** 画像が無い指摘のサムネイル。単色のアイコンを1つだけ置く */
export function NoImageArt() {
  return <ImageOff className="rv-noimage" size={16} aria-hidden="true" />
}
