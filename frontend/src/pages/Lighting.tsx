import { useCallback, useEffect, useRef, useState } from 'react'
import ColorPicker from '../components/ColorPicker'
import { useToast } from '../components/Toast'
import {
  LIGHTING_DEFAULTS,
  PRESET_COLORS,
  RGB_MATRIX_EFFECTS,
  colorEnabled,
  hsvToCss,
  speedEnabled,
  type LightingState,
} from '../config/lighting'
import { api, type DeviceStatus } from '../lib/bridge'
import { hsvToHex } from '../lib/color'
import { registerActions, setPageBusy } from '../lib/kbStore'

interface Props {
  status: DeviceStatus | null
}

/** 拖动时的防抖间隔：既跟手，又不会把 HID 灌满 */
const LIVE_DEBOUNCE_MS = 70

export default function LightingPage({ status }: Props) {
  const toast = useToast()
  const [state, setState] = useState<LightingState>(LIGHTING_DEFAULTS)
  const [applying, setApplying] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const live = true
  const connected = Boolean(status?.connected)

  // 待下发的字段（只发真正改动过的那几路，避免每次重设灯效导致动画重启）
  const pendingRef = useRef<Partial<LightingState>>({})
  const timerRef = useRef<number | null>(null)
  const flushingRef = useRef(false)
  const stateRef = useRef<LightingState>(state)
  stateRef.current = state

  const load = useCallback(async () => {
    if (!connected) return
    try {
      const v = await api.readLighting()
      setState((prev) => ({
        effect: typeof v.effect === 'number' ? v.effect : prev.effect,
        brightness: typeof v.brightness === 'number' ? v.brightness : prev.brightness,
        speed: typeof v.speed === 'number' ? v.speed : prev.speed,
        hue: typeof v.hue === 'number' ? v.hue : prev.hue,
        sat: typeof v.sat === 'number' ? v.sat : prev.sat,
      }))
    } catch {
      // 部分固件不支持读回，静默使用默认值
    }
  }, [connected])

  useEffect(() => {
    void load()
  }, [load])

  // 导入配置后自动刷新，别让界面显示旧值
  useEffect(() => {
    const h = () => void load()
    window.addEventListener('al80:config-applied', h)
    return () => window.removeEventListener('al80:config-applied', h)
  }, [load])

  /** 把排队中的改动真正写进键盘。顺序：灯效 → 速度 → 颜色 → 亮度。 */
  const flush = useCallback(async () => {
    if (!pendingRef.current || !Object.keys(pendingRef.current).length) return
    // 上一批还在写就等它写完（HID 写入不能并发）
    if (flushingRef.current) return
    flushingRef.current = true
    const p = pendingRef.current
    pendingRef.current = {}
    const s = stateRef.current
    try {
      if (p.effect !== undefined) {
        await api.setLightingValue(2, p.effect)
      }
      if (p.speed !== undefined && speedEnabled(s.effect)) {
        await api.setLightingValue(3, p.speed)
      }
      if ((p.hue !== undefined || p.sat !== undefined) && colorEnabled(s.effect)) {
        await api.setLightingColor(s.hue, s.sat, 255)
      }
      // 全熄档固件忽略亮度，别白发
      if (p.brightness !== undefined && s.effect !== 0) {
        await api.setLightingValue(1, p.brightness)
      }
    } catch (e) {
      // 拖动过程中静默失败，避免刷屏；点按钮下发时会给出明确错误
      console.warn('live lighting failed', e)
    } finally {
      flushingRef.current = false
      // 写入期间又有新改动 → 接着发
      if (pendingRef.current && Object.keys(pendingRef.current).length) {
        window.setTimeout(() => void flush(), 30)
      }
    }
  }, [])

  const scheduleLive = useCallback(() => {
    if (!live || !connected) return
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void flush()
    }, LIVE_DEBOUNCE_MS)
  }, [live, connected, flush])

  // 卸载时把没发完的改动补发一次
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
        void flush()
      }
    }
  }, [flush])

  const update = (patch: Partial<LightingState>) => {
    // 同步更新 ref：flush() 可能在同一事件里就被调用，
    // 而 React 的 setState 要到下一次渲染才生效，读 state 会拿到旧值。
    stateRef.current = { ...stateRef.current, ...patch }
    setState((s) => ({ ...s, ...patch }))
    pendingRef.current = { ...pendingRef.current, ...patch }
    scheduleLive()
  }

  /** 松手立刻发一次，不等防抖 */
  const flushNow = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    void flush()
  }

  const apply = async () => {
    if (!connected) {
      toast.push('warn', '还没连接键盘：请用数据线连接后再下发灯光')
      return
    }
    if (state.effect === 0) {
      toast.push('warn', '当前灯效是「全熄」：固件会忽略亮度和颜色，键盘不会亮。先选一个别的灯效再调。')
    }
    setApplying(true)
    pendingRef.current = {}
    try {
      await api.applyLighting(
        state.brightness,
        state.effect,
        speedEnabled(state.effect) ? state.speed : -1,
        colorEnabled(state.effect) ? state.hue : -1,
        colorEnabled(state.effect) ? state.sat : -1,
      )
      const after = await api.readLighting().catch(() => null)
      if (after && typeof after.brightness === 'number') {
        setState((s) => ({ ...s, brightness: after.brightness as number }))
      }
      toast.push('ok', '灯光已下发（亮度读回可能有 ±1 量化误差，属正常）')
    } catch (e) {
      toast.push('err', `下发失败：${(e as Error).message}`)
    } finally {
      setApplying(false)
    }
  }

  const reset = async () => {
    setState(LIGHTING_DEFAULTS)
    toast.push('info', '已恢复默认值，点左侧「保存到键盘」写入')
  }

  // 左侧「保存到键盘 / 恢复默认」统一入口
  useEffect(() => {
    registerActions('lighting', {
      save: () => void apply(),
      reset: () => void reset(),
    })
  })

  useEffect(() => {
    setPageBusy('lighting', applying)
  }, [applying])


  const current = RGB_MATRIX_EFFECTS.find((e) => e.id === state.effect)
  const lampColor = colorEnabled(state.effect) ? hsvToCss(state.hue, state.sat, 255) : '#2a3040'
  const lampOpacity = 0.15 + (state.brightness / 255) * 0.85

  return (
    <div className="page lighting-page">

      <section className="panel">
        <div className="panel-head">
          <h3>灯效模式</h3>
          <span className="panel-sub">{current ? `${current.cn} / ${current.en}` : '—'}</span>
        </div>
        <div className="effect-grid">
          {RGB_MATRIX_EFFECTS.map((e) => (
            <button
              key={e.id}
              className={`effect-chip ${state.effect === e.id ? 'active' : ''}`}
              onClick={() => {
                // 选灯效时把亮度一起带上：从「全熄」切回来时不用再拖一次
                if (e.id !== 0 && state.brightness < 40) {
                  update({ effect: e.id, brightness: 200 })
                } else {
                  update({ effect: e.id })
                }
                flushNow()
              }}
            >
              <span className="effect-cn">{e.cn}</span>
              <span className="effect-en">{e.en}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="two-col">
        <section className={`panel ${state.effect === 0 ? 'disabled' : ''}`}>
          <div className="panel-head">
            <h3>亮度与速度</h3>
          </div>
          <div className={`field ${state.effect === 0 ? 'disabled' : ''}`}>
            <label>
              亮度 <b className="mono">{state.brightness}</b>
            </label>
            <input
              type="range"
              min={0}
              max={255}
              value={state.brightness}
              disabled={state.effect === 0}
              onChange={(e) => update({ brightness: Number(e.target.value) })}
              onPointerUp={flushNow}
              onKeyUp={flushNow}
            />
          </div>
          <div className={`field ${speedEnabled(state.effect) ? '' : 'disabled'}`}>
            <label>
              速度 <b className="mono">{state.speed}</b>
            </label>
            <input
              type="range"
              min={0}
              max={255}
              value={state.speed}
              disabled={!speedEnabled(state.effect)}
              onChange={(e) => update({ speed: Number(e.target.value) })}
              onPointerUp={flushNow}
              onKeyUp={flushNow}
            />
          </div>
        </section>

        <section className="panel color-panel">
          <div className="panel-head">
            <h3>颜色</h3>
            <span className="panel-sub mono">{hsvToHex(state.hue, state.sat, state.brightness).toUpperCase()}</span>
          </div>
          <div className="color-preview-row">
            <span className="color-chip" style={{ background: lampColor, opacity: lampOpacity }} />
            <div className="color-meta">
              <span className="color-meta-label">色相 {state.hue} · 饱和 {state.sat}</span>
              <button
                className="btn ghost small"
                onClick={() => {
                  if (!colorEnabled(state.effect)) {
                    toast.push('warn', '当前是「全熄」，颜色要配合别的灯效才看得见；可以先选好颜色再切灯效')
                  }
                  setPickerOpen(true)
                }}
              >
                自定义
              </button>
            </div>
          </div>
          <div className="swatches">
            {PRESET_COLORS.map((c) => (
              <button
                key={c.label}
                className={`swatch ${state.hue === c.hue && state.sat === c.sat ? 'active' : ''}`}
                style={{ background: hsvToCss(c.hue, c.sat, 255) }}
                onClick={() => {
                  update({ hue: c.hue, sat: c.sat })
                  flushNow()
                }}
                title={c.label}
              />
            ))}
          </div>
        </section>
      </div>

      {pickerOpen && (
        <div className="modal-mask" onClick={() => setPickerOpen(false)}>
          <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <div className="modal-title">自定义颜色</div>
                <div className="modal-sub">色盘选色相与饱和度，滑条调明度，也可以直接输入 HEX 或用吸管取色</div>
              </div>
              <button className="btn icon" onClick={() => setPickerOpen(false)} aria-label="关闭">
                ✕
              </button>
            </div>
            <ColorPicker
              hue={state.hue}
              sat={state.sat}
              value={state.brightness}
              onChange={(c) => update({ hue: c.hue, sat: c.sat, brightness: c.value })}
              onDone={flushNow}
            />
            <div className="modal-actions">
              <button className="btn primary" onClick={() => setPickerOpen(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}