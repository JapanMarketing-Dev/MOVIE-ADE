import { lazy, useState, type ComponentType } from 'react'

/**
 * React.lazy と同じく遅れて読む部品。ただし先に読み終わっていれば、Suspense を通さずにすぐ描く。
 *
 * React.lazy は読み込み済みのときも初めて描くときに一度止まり（Suspense の fallback）、
 * React 19 はその切り替えを最大 300ms 間引くので、先読みしてあっても開くたびに待たされる。
 * 読み込みの前に描いたものは、その後も lazy の方のまま使う（途中で入れ替えると作り直しになる）。
 */
export function preloadable<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): {
  Component: ComponentType<P>
  preload: () => Promise<unknown>
} {
  let loaded: ComponentType<P> | null = null
  let pending: Promise<{ default: ComponentType<P> }> | null = null
  const preload = () => {
    pending ??= load().then((module) => {
      loaded = module.default
      return module
    }, (err: unknown) => {
      // 読めなかったら次に開くときに読み直す
      pending = null
      throw err
    })
    return pending
  }
  const Lazy = lazy(preload)
  function Component(props: P) {
    const [Chosen] = useState<ComponentType<P>>(() => loaded ?? Lazy)
    return <Chosen {...props} />
  }
  return { Component, preload }
}
