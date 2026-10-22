import { useEffect, useState } from 'react'

/** 3D / 扁平键帽图需要的数据，由「键盘设置」页写入，顶部视角面板读取 */
export interface Pick {
  row: number
  col: number
}

interface KbState {
  labels: Record<string, string>
  dirty: Set<string>
  pressed: Set<string>
  layer: number
  ready: boolean
  /** 按键检测延迟（ms），侧栏显示 */
  detectMs: number
  /** 每分钟按键次数（只在按键设置页轮询时更新） */
  apm: number
  /** 待写入改动数，底部工具条显示 */
  dirtyCount: number
  /** 当前正在写入的模块（null = 空闲） */
  savingBy: ActionPage | null

  /** 矩阵原始掩码（6 组 4 位十六进制），顶部状态栏显示 */
  rowsMask: string

}

const initial: KbState = {
  labels: {},
  dirty: new Set(),
  pressed: new Set(),
  layer: 0,
  ready: false,
  detectMs: 0,
  apm: 0,
  dirtyCount: 0,
  savingBy: null,
  rowsMask: '',

}

let state: KbState = initial
const subs = new Set<(s: KbState) => void>()

function emit() {
  const s = state
  subs.forEach((fn) => fn(s))
}

/** 每个模块把自己的「保存 / 恢复默认」注册到这里，左侧按钮统一调用当前模块的 */
export type ActionPage = 'keymap' | 'lighting' | 'screen' | 'macro'

interface PageActions {
  save?: () => void
  reset?: () => void
}

const registry = new Map<ActionPage, PageActions>()

const busy = new Map<ActionPage, boolean>()

/** 各模块写入开始时标记自己、结束清除；左侧按钮据此显示进度 */
export function setPageBusy(page: ActionPage, on: boolean) {
  if (on) busy.set(page, true)
  else busy.delete(page)
  state = { ...state, savingBy: Array.from(busy.keys())[0] ?? null }
  emit()
}

export function registerActions(page: ActionPage, actions: PageActions) {
  registry.set(page, actions)
}

export const markBusy = setPageBusy

export function runSave(page: ActionPage) {
  registry.get(page)?.save?.()
}

export function runReset(page: ActionPage) {
  registry.get(page)?.reset?.()
}

export function setKbState(patch: Partial<KbState>) {
  // 浅比较：值没变就不通知，省掉整棵组件树的无意义重渲染
  let changed = false
  for (const k of Object.keys(patch) as (keyof KbState)[]) {
    if (!Object.is(state[k], patch[k])) {
      changed = true
      break
    }
  }
  if (!changed) return
  state = { ...state, ...patch }
  emit()
}

/** 顶部 3D / 2D 键帽被点击时，交给当前注册的模块处理（按键设置用它选两个键位） */
let viewPick: ((row: number, col: number) => void) | null = null

export function setViewPickHandler(fn: ((row: number, col: number) => void) | null) {
  viewPick = fn
}

export function emitViewPick(row: number, col: number) {
  viewPick?.(row, col)
}



export function useKbState(): KbState {
  const [snap, setSnap] = useState<KbState>(state)
  useEffect(() => {
    subs.add(setSnap)
    setSnap(state)
    return () => {
      subs.delete(setSnap)
    }
  }, [])
  return snap
}