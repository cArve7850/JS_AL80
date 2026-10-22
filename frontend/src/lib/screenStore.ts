/**
 * 键盘那块小屏幕当前显示的画面（96×160）在这里中转一份。
 * 「屏幕」页生成预览/发送成功后写进来，3D 模型订阅它，于是模型上的屏和实机屏一致。
 * 同时落到 localStorage：重启软件后模型上仍然是上次那张图，不会变回"无图"。
 * 注意：AL80 固件没有回读屏幕内容的接口，所以镜像的是"最近一次生成/发送的画面"。
 */
type Listener = (dataUrl: string | null) => void

const LS_KEY = 'al80.screenImage'

let current: string | null = null
try {
  current = window.localStorage.getItem(LS_KEY)
} catch {
  current = null
}

const listeners = new Set<Listener>()

export function setScreenImage(dataUrl: string | null) {
  if (dataUrl === current) return
  current = dataUrl
  try {
    if (dataUrl) window.localStorage.setItem(LS_KEY, dataUrl)
    else window.localStorage.removeItem(LS_KEY)
  } catch {
    /* 配额满了就算了，不影响画面显示 */
  }
  listeners.forEach((fn) => {
    try {
      fn(current)
    } catch {
      /* 忽略单个订阅者的异常 */
    }
  })
}

export function getScreenImage(): string | null {
  return current
}

export function onScreenImage(fn: Listener): () => void {
  listeners.add(fn)
  if (current) {
    try {
      fn(current)
    } catch {
      /* ignore */
    }
  }
  return () => listeners.delete(fn)
}
