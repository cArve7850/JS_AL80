import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import KeyPicker from '../components/KeyPicker'
import { useToast } from '../components/Toast'
import { AL80_LAYOUT, KNOB } from '../config/keymap.layout'
import { api, onEvent, type DeviceStatus, type KeymapData, type KeyWatchState } from '../lib/bridge'
import { kcName } from '../lib/keycodes'
import {
  registerActions,
  setKbState,
  setPageBusy,
  setViewPickHandler,
  useKbState,
  type Pick,
} from '../lib/kbStore'

const SHORT_LABELS: Record<string, string> = {
  // 符号型：真键盘上就是印这些图标
  Space: '␣',
  Enter: '⏎',
  Backspace: '⌫',
  Delete: '⌦',
  Tab: '⇥',
  'Caps Lock': '⇪',
  'Left Shift': '⇧',
  'Right Shift': '⇧',
  'Left Ctrl': 'Ctrl',
  'Right Ctrl': 'Ctrl',
  'Left Alt': 'Alt',
  'Right Alt': 'Alt',
  'Left Win': '⊞',
  'Right Win': '⊞',
  Menu: '☰',
  'Print Screen': 'PrtSc',
  'Scroll Lock': 'ScrLk',
  'Page Up': 'PgUp',
  'Page Down': 'PgDn',
  Insert: 'Ins',
  'Num Lock': 'Num',
}

/** 单字符符号用大字号显示更清楚 */
const GLYPHS = new Set([
  '␣', '⏎', '⌫', '⌦', '⇥', '⇪', '⇧', '⊞', '☰', '▽', '←', '↓', '↑', '→',
])

function shortLabel(kc: number): string {
  const full = kcName(kc)
  if (full.startsWith('MO(')) return 'Fn'
  return SHORT_LABELS[full] ?? full
}

type SlotB = { kind: 'pick'; row: number; col: number } | { kind: 'code'; code: number }

type PickerTarget =
  | { kind: 'key'; row: number; col: number }
  | { kind: 'slotB' }
  | { kind: 'knobCW' }
  | { kind: 'knobCCW' }
  | { kind: 'knobPush' }

interface Props {
  status: DeviceStatus | null
  onNeedConnect: () => void
  /** 是否正显示在本页（别的模块时仍挂载，但不能抢占设备） */
  active: boolean
}

export default function KeymapPage({ status, onNeedConnect, active }: Props) {
  const toast = useToast()
  const kb = useKbState()
  const [data, setData] = useState<KeymapData | null>(null)
  const [layer, setLayer] = useState(0)
  const [draft, setDraft] = useState<Record<string, number>>({})
  const [picker, setPicker] = useState<PickerTarget | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [watching, setWatching] = useState(true)
  const [pressed, setPressed] = useState<Set<string>>(new Set())
  const latch = useRef<Map<string, number>>(new Map())
  const [rowsMask, setRowsMask] = useState('')
  const [watchError, setWatchError] = useState('')
  const [detectMs, setDetectMs] = useState(0)
  const [apm, setApm] = useState(0)
  const pressTimes = useRef<number[]>([])
  const [layerClip, setLayerClip] = useState<{ layer: number; cells: Record<string, number> } | null>(
    null,
  )

  const connected = Boolean(status?.connected)
  const encoderConfigurable = Boolean(status?.encoderConfigurable)

  const load = useCallback(async () => {
    if (!connected) return
    setLoading(true)
    try {
      const km = await api.readKeymap()
      setData(km)
      setDraft({})
      if (layer >= km.layers.length) setLayer(0)
    } catch (e) {
      toast.push('err', `读取键位失败：${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [connected, layer, toast])

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])

  // 导入配置后自动刷新，避免界面还显示旧键位
  useEffect(() => {
    const h = () => void load()
    window.addEventListener('al80:config-applied', h)
    return () => window.removeEventListener('al80:config-applied', h)
  }, [load])

  // 实时按键高亮：进入本页且已连接时，轮询键盘原始矩阵状态
  useEffect(() => {
    if (!connected || !watching || !active) {
      setPressed(new Set())
      if (connected) api.stopKeyWatch().catch(() => undefined)
      return
    }
    let alive = true
    setWatchError('')
    api.startKeyWatch().catch((e) => {
      if (alive) setWatchError((e as Error).message)
    })
    const flushPressed = () => {
      const now = Date.now()
      const next = new Set<string>()
      for (const [id, t] of latch.current) {
        if (now - t < 45) next.add(id)
        else latch.current.delete(id)
      }
      setPressed((prev) => (prev.size === next.size && [...next].every((k) => prev.has(k)) ? prev : next))
    }
    const off = onEvent<KeyWatchState>('key:watch', (s) => {
      if (!alive || !s) return
      if (s.error) {
        setWatchError(s.error)
        return
      }
      // 恢复后把错误提示清掉（只在原来是错误时才更新，避免每帧都渲染）
      setWatchError((e) => (e ? '' : e))
      const now = Date.now()
      // 设备每 16ms 推一帧「当前按下的键」；这里只留 45ms 余晖，防止超快轻敲被采样漏掉。
      // 按住不放时设备会持续推送，所以高亮会一直保持。
      const sAny = s as unknown as { ts?: number; latMs?: number }
      if (sAny.ts) {
        const ms = Math.max(0, Date.now() - sAny.ts) + (sAny.latMs ?? 0)
        setDetectMs((prev) => (prev ? Math.round(prev * 0.8 + ms * 0.2) : Math.round(ms)))
      }
      for (const p of s.pressed ?? []) {
        const id = `${p[0]},${p[1]}`
        if (!latch.current.has(id)) {
          pressTimes.current.push(now)
          if (pressTimes.current.length > 600) {
            pressTimes.current.splice(0, pressTimes.current.length - 600)
          }
        }
        latch.current.set(id, now)
      }
      // 每帧都刷新：按下和松开都要立刻反映，不等定时器
      flushPressed()
      if (s.rows) {
        setRowsMask(
          s.rows.map((r) => r.toString(16).toUpperCase().padStart(4, '0')).join(' '),
        )
      }
    })
    // 余晖到期才需要定时器兜底清理
    const timer = window.setInterval(flushPressed, 40)
    const apmTimer = window.setInterval(() => {
      const cutoff = Date.now() - 60000
      pressTimes.current = pressTimes.current.filter((x) => x >= cutoff)
      setApm(pressTimes.current.length)
    }, 1000)
    return () => {
      alive = false
      off()
      window.clearInterval(timer)
      window.clearInterval(apmTimer)
      latch.current.clear()
      api.stopKeyWatch().catch(() => undefined)
      setPressed(new Set())
    }
  }, [connected, watching, active])

  const layers = data?.layers ?? []
  const currentLayer = Math.min(layer, Math.max(layers.length - 1, 0))

  const kcAt = useCallback(
    (row: number, col: number): number => {
      const key = `${currentLayer}:${row},${col}`
      if (key in draft) return draft[key]
      const idx = row * (data?.cols ?? 15) + col
      return layers[currentLayer]?.[idx] ?? 0
    },
    [currentLayer, data?.cols, draft, layers],
  )

  // [0] = 顺时针（固件不回报，只能用本地记住的值显示），[1] = 逆时针（可读回）
  const encoder = (data?.encoders?.[currentLayer] as [number, number]) ?? [0, 0]
  const [cwKnown, setCwKnown] = useState<Record<number, number>>({})

  const dirtyCount = Object.keys(draft).length

  // 3D 模型用的数据（键帽文字 / 待写入 / 正在按下）
  const modelLabels = useMemo(() => {
    const m: Record<string, string> = {}
    for (const spot of AL80_LAYOUT) {
      m[spot.id] = connected ? shortLabel(kcAt(spot.row, spot.col)) : ''
    }
    return m
  }, [connected, kcAt])

  const modelDirty = useMemo(() => {
    const s = new Set<string>()
    for (const k of Object.keys(draft)) {
      const [layerStr, pos] = k.split(':')
      if (Number(layerStr) === currentLayer) s.add(pos)
    }
    return s
  }, [draft, currentLayer])

  // 把键位/待写入/按下状态推给中间键盘视角与两侧栏、底部按钮
  useEffect(() => {
    setKbState({
      labels: modelLabels,
      dirty: modelDirty,
      pressed,
      layer: currentLayer,
      ready: Boolean(data),
      detectMs,
      dirtyCount,
      apm,
      rowsMask,
    })
  }, [modelLabels, modelDirty, pressed, currentLayer, data, detectMs, apm, dirtyCount, rowsMask])


  const apply = async () => {
    if (!connected) return onNeedConnect()
    const changes = Object.entries(draft).map(([key, keycode]) => {
      const [layerStr, pos] = key.split(':')
      const [row, col] = pos.split(',').map(Number)
      return { layer: Number(layerStr), row, col, keycode }
    })
    if (changes.length === 0) {
      toast.push('info', '没有需要写入的改动')
      return
    }
    setApplying(true)
    try {
      const applied = await api.applyKeymap(changes)
      toast.push('ok', `已写入键盘：${applied} 个按键改动`)
      await load()
    } catch (e) {
      toast.push('err', `写入失败：${(e as Error).message}`)
    } finally {
      setApplying(false)
    }
  }

  const resetDefaults = async () => {
    setDraft({})
    await load()
    toast.push('info', '已恢复为键盘上的当前键位（放弃未应用的改动）')
  }

  // 左侧「保存到键盘 / 恢复默认」统一入口
  useEffect(() => {
    registerActions('keymap', {
      save: () => void apply(),
      reset: () => void resetDefaults(),
    })
  })

  useEffect(() => {
    setPageBusy('keymap', applying)
  }, [applying])

  const pickerCurrent = (): number => {
    if (!picker) return 0
    if (picker.kind === 'key') return kcAt(picker.row, picker.col)
    if (picker.kind === 'slotB')
      return selB?.kind === 'code' ? selB.code : selB ? kcAt(selB.row, selB.col) : 0
    if (picker.kind === 'knobCW') return 0
    if (picker.kind === 'knobCCW') return encoder[1]
    return kcAt(KNOB.row, KNOB.col)
  }

  const onPick = (kc: number) => {
    if (!picker) return
    if (picker.kind === 'key') {
      setDraft((d) => ({ ...d, [`${currentLayer}:${picker.row},${picker.col}`]: kc }))
    } else if (picker.kind === 'slotB') {
      setSelB({ kind: 'code', code: kc })
      setSlotMode('none')
    } else if (picker.kind === 'knobCW' || picker.kind === 'knobCCW') {
      // 旋钮键码写完立刻生效，不进草稿（顺时针的槽位固件不回报，无法读回校验）
      const clockwise = picker.kind === 'knobCW'
      void api
        .setEncoderKey(currentLayer, clockwise, kc)
        .then(() => {
          toast.push('ok', `旋钮${clockwise ? '顺时针' : '逆时针'}已设为 ${kcName(kc)}`)
          return load()
        })
        .catch((e: unknown) => toast.push('err', `写入失败：${(e as Error).message}`))
    } else {
      setDraft((d) => ({ ...d, [`${currentLayer}:${KNOB.row},${KNOB.col}`]: kc }))
    }
    setPicker(null)
  }

  // 整层复制 / 粘贴（只改前端草稿，点「应用到键盘」才写进键盘）
  const copyLayer = () => {
    const cells: Record<string, number> = {}
    for (const spot of AL80_LAYOUT) {
      cells[`${spot.row},${spot.col}`] = kcAt(spot.row, spot.col)
    }
    setLayerClip({ layer: currentLayer, cells })
    toast.push('info', `已复制第 ${currentLayer + 1} 层（${AL80_LAYOUT.length} 个键）`)
  }

  const pasteLayer = () => {
    if (!layerClip) return
    setDraft((d) => {
      const next = { ...d }
      for (const [pos, kc] of Object.entries(layerClip.cells)) {
        next[`${currentLayer}:${pos}`] = kc
      }
      return next
    })
    toast.push(
      'ok',
      `已把第 ${layerClip.layer + 1} 层粘贴到第 ${currentLayer + 1} 层，记得点「应用到键盘」`,
    )
  }

  // ---- 两个键位：点槽位 → 点上面键盘选键 → 应用（把键位 2 的键码写到键位 1）----
  const [selA, setSelA] = useState<Pick | null>(null)
  const [selB, setSelB] = useState<SlotB | null>(null)
  const [slot, setSlot] = useState<"none" | "a" | "b">("none")
  const slotRef = useRef<"none" | "a" | "b">("none")
  const [pairBusy, setPairBusy] = useState(false)

  const setSlotMode = (m: "none" | "a" | "b") => {
    slotRef.current = m
    setSlot(m)
  }

  useEffect(() => {
    if (!active) {
      setViewPickHandler(null)
      return
    }
    setViewPickHandler((row, col) => {
      if (slotRef.current === "a") {
        setSelA({ row, col })
        setSelB(null)
        setSlotMode("b")
      } else if (slotRef.current === "b") {
        setSelB({ kind: "pick", row, col })
        setSlotMode("none")
      }
    })
    return () => setViewPickHandler(null)
  }, [active])

  const applyPair = async () => {
    if (!connected) return onNeedConnect()
    if (!selA || !selB) return
    const keycode = selB.kind === 'pick' ? kcAt(selB.row, selB.col) : selB.code
    setPairBusy(true)
    try {
      await api.applyKeymap([{ layer: currentLayer, row: selA.row, col: selA.col, keycode }])
      toast.push("ok", `已写入 [${selA.row},${selA.col}] = ${kcName(keycode)}`)
      setSelA(null)
      setSelB(null)
      setSlotMode("none")
      await load()
    } catch (e) {
      toast.push("err", `写入失败：${(e as Error).message}`)
    } finally {
      setPairBusy(false)
    }
  }

  return (
    <div className="page">
      <div className="layer-bar">
        <div className="layer-capsule">
          <span className="layer-label">层</span>
          {Array.from({ length: Math.max(layers.length, 1) }, (_, i) => (
            <button
              key={i}
              className={`chip ${currentLayer === i ? "active" : ""}`}
              onClick={() => setLayer(i)}
            >
              {i + 1}
            </button>
          ))}
          <span className="layer-sep" />
          <button className="btn ghost tiny" onClick={() => void load()} disabled={loading || !connected}>
            {loading ? "读取中…" : "重新读取"}
          </button>
          <button
            className={`btn tiny ${watching ? "primary" : ""}`}
            disabled={!connected}
            onClick={() => setWatching((w) => !w)}
          >
            {watching ? "按键检测：开" : "按键检测：关"}
          </button>
          <span className="layer-sep" />
          <button className="btn ghost tiny" onClick={copyLayer} disabled={!connected}>
            复制本层
          </button>
          <button className="btn ghost tiny" onClick={pasteLayer} disabled={!connected || !layerClip}>
            粘贴到本层
          </button>
          <span className="layer-sep" />
          <span className="layer-apm">
            <span className="layer-label">APM</span>
            <span className="layer-apm-num mono">{apm}</span>
          </span>
        </div>
      </div>


      <section className="panel pair-panel">
        <div className="panel-head">
          <h3>键位绑定</h3>
        </div>

        <div className="pair-row">
          <div
            role="button"
            tabIndex={0}
            className={`pair-slot ${slot === "a" ? "armed" : ""} ${selA ? "filled" : ""}`}
            onClick={() => setSlotMode(slot === "a" ? "none" : "a")}
          >
            <span className="pair-index">键位 1</span>
            <span className="pair-value">{selA ? kcName(kcAt(selA.row, selA.col)) : "—"}</span>
            <span className="pair-pos mono">{selA ? `[${selA.row},${selA.col}]` : ""}</span>
          </div>

          <span className={`pair-arrow ${selB ? "on" : ""}`}>→</span>

          <div
            role="button"
            tabIndex={0}
            className={`pair-slot ${slot === "b" ? "armed" : ""} ${selB ? "filled" : ""}`}
            onClick={() => setSlotMode(slot === "b" ? "none" : "b")}
          >
            <span className="pair-index">键位 2</span>
            <span className="pair-value">
              {selB
                ? kcName(selB.kind === "pick" ? kcAt(selB.row, selB.col) : selB.code)
                : "—"}
            </span>
            <span className="pair-pos mono">
              {selB?.kind === "pick" ? `[${selB.row},${selB.col}]` : selB ? "键码" : ""}
            </span>
            <button
              className="pair-more"
              onClick={(e) => {
                e.stopPropagation()
                setPicker({ kind: "slotB" })
              }}
            >
              选键码
            </button>
          </div>

          <button
            className="btn primary pair-apply"
            onClick={() => void applyPair()}
            disabled={!connected || !selA || !selB || pairBusy}
          >
            {pairBusy ? "写入中…" : "应用"}
          </button>
        </div>
      </section>

      <div className="knob-card">
        <div className="knob-title">
          <span className="knob-icon">◉</span> 旋钮
        </div>
        <div className="knob-row">
          <button
            className="knob-cell"
            disabled={!encoderConfigurable || !connected}
            onClick={() => setPicker({ kind: "knobCW" })}
          >
            <span className="knob-dir">↻ 顺时针</span>
            <span className="knob-val">{connected && cwKnown[currentLayer] ? kcName(cwKnown[currentLayer]) : "—"}</span>
          </button>
          <button
            className={`knob-cell ${pressed.has(`${KNOB.row},${KNOB.col}`) ? "pressed" : ""}`}
            onClick={() => setPicker({ kind: "knobPush" })}
          >
            <span className="knob-dir">● 按下</span>
            <span className="knob-val">{connected ? kcName(kcAt(KNOB.row, KNOB.col)) : "—"}</span>
          </button>
          <button
            className="knob-cell"
            disabled={!encoderConfigurable || !connected}
            onClick={() => setPicker({ kind: "knobCCW" })}
          >
            <span className="knob-dir">↺ 逆时针</span>
            <span className="knob-val">{connected ? kcName(encoder[1]) : "—"}</span>
          </button>
        </div>
      </div>

      <KeyPicker
        open={picker !== null}
        title={
          picker?.kind === 'key'
            ? `第 ${currentLayer + 1} 层 · [${picker.row},${picker.col}]`
            : picker?.kind === 'knobCW' || picker?.kind === 'knobCCW'
              ? `第 ${currentLayer + 1} 层 · 旋钮旋转`
              : `第 ${currentLayer + 1} 层 · 旋钮按下`
        }
        current={pickerCurrent()}
        layerCount={layers.length || 4}
        onPick={onPick}
        onClose={() => setPicker(null)}
      />
    </div>
  )
}
