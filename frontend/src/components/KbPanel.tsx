import { useEffect, useRef, useState } from 'react'
import KbModel from './KbModel'
import { AL80_LAYOUT, KNOB, LAYOUT_WIDTH_UNITS } from '../config/keymap.layout'
import { emitViewPick, useKbState } from '../lib/kbStore'

interface Props {
  connected: boolean
  tilt: boolean
}

const ROWS = 6
const PAD = 22
/** 2D 视图按面板尺寸缩放后再留一点余量，比 3D 稍小一圈 */
const SCALE = 0.86

/**
 * 中间的键盘视角：3D 模型与 2D 键帽图都常驻（切换只改显隐，不重建场景）。
 * 点键帽会通知当前模块（按键设置用它选「键位 1 / 键位 2」）。
 */
export default function KbPanel({ connected, tilt }: Props) {
  const kb = useKbState()
  const boxRef = useRef<HTMLElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  const availW = Math.max(box.w - PAD * 2, 0)
  const availH = Math.max(box.h - PAD * 2, 0)
  const unitW = availW > 0 ? availW / LAYOUT_WIDTH_UNITS : 0
  const unitH = availH > 0 ? availH / ROWS - 4 : 0
  const unit = Math.max(14, Math.min(unitW || 40, unitH || 40) * SCALE)
  const canvasW = LAYOUT_WIDTH_UNITS * unit
  const canvasH = ROWS * (unit + 4)

  return (
    <section className="kbpanel" ref={boxRef}>
      <div className={`kbpanel-model ${tilt ? '' : 'off'}`}>
        <KbModel
          labels={kb.labels}
          dirty={kb.dirty}
          pressed={kb.pressed}
          paused={!tilt}
          onPick={(row, col) => emitViewPick(row, col)}
        />
      </div>

      <div className={`kbpanel-flat ${tilt ? 'off' : ''}`}>
        <div className="kb-canvas" style={{ width: canvasW, height: canvasH }}>
          {AL80_LAYOUT.map((spot) => {
            const label = connected ? (kb.labels[spot.id] ?? '') : ''
            const isDirty = kb.dirty.has(`${spot.row},${spot.col}`)
            const isPressed = kb.pressed.has(spot.id)
            const isKnob = spot.row === KNOB.row && spot.col === KNOB.col
            return (
              <button
                key={spot.id}
                className={`keycap ${isDirty ? 'dirty' : ''} ${isPressed ? 'pressed' : ''} ${isKnob ? 'knob-key' : ''}`}
                style={{
                  left: spot.x * unit,
                  top: spot.y * (unit + 4),
                  width: spot.w * unit - 4,
                  height: unit - 4,
                }}
                onClick={() => emitViewPick(spot.row, spot.col)}
                title={label}
              >
                <span className={`keycap-label ${label.length > 5 ? 'long' : ''}`}>{label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
