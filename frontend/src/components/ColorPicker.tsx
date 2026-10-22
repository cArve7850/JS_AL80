import { useEffect, useRef, useState } from 'react'
import { hexToHsv, hsvToHex, hsvToRgb } from '../lib/color'

interface Props {
  /** 0..255 */
  hue: number
  /** 0..255 */
  sat: number
  /** 0..255，映射到键盘亮度 */
  value: number
  size?: number
  disabled?: boolean
  onChange: (next: { hue: number; sat: number; value: number }) => void
  onDone?: () => void
}

/**
 * 完整取色器：色盘（角度=色相，半径=饱和度）+ 明度滑条 + HEX 输入 + 屏幕吸管。
 * 明度直接对应键盘亮度，所以拖动它就是调亮度，不再有第二套「亮度」概念。
 */
export default function ColorPicker({
  hue,
  sat,
  value,
  size = 208,
  disabled,
  onChange,
  onDone,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const draggingRef = useRef(false)
  const [hexText, setHexText] = useState(hsvToHex(hue, sat, value))
  const [hexBad, setHexBad] = useState(false)
  const [eyeOk, setEyeOk] = useState(false)

  useEffect(() => {
    setHexText(hsvToHex(hue, sat, value))
    setHexBad(false)
  }, [hue, sat, value])

  useEffect(() => {
    setEyeOk(typeof window !== 'undefined' && 'EyeDropper' in window)
  }, [])

  // 画色盘：只画色相/饱和度，明度由下面的滑条控制
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    const px = Math.round(size * dpr)
    cv.width = px
    cv.height = px
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(px, px)
    const cx = px / 2
    const cy = px / 2
    const r = px / 2 - dpr
    for (let y = 0; y < px; y++) {
      const dy = y - cy
      for (let x = 0; x < px; x++) {
        const dx = x - cx
        const dist = Math.sqrt(dx * dx + dy * dy)
        const i = (y * px + x) * 4
        if (dist > r) {
          img.data[i + 3] = 0
          continue
        }
        let ang = Math.atan2(dy, dx) * (180 / Math.PI)
        if (ang < 0) ang += 360
        const [rr, gg, bb] = hsvToRgb((ang / 360) * 255, Math.min(1, dist / r) * 255, 255)
        img.data[i] = rr
        img.data[i + 1] = gg
        img.data[i + 2] = bb
        img.data[i + 3] = dist > r - dpr ? Math.round((255 * (r - dist)) / dpr) : 255
      }
    }
    ctx.putImageData(img, 0, 0)
  }, [size])

  const pickAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return
    const cv = canvasRef.current
    if (!cv) return
    const rect = cv.getBoundingClientRect()
    const dx = e.clientX - (rect.left + rect.width / 2)
    const dy = e.clientY - (rect.top + rect.height / 2)
    let ang = Math.atan2(dy, dx) * (180 / Math.PI)
    if (ang < 0) ang += 360
    const s = Math.min(1, Math.sqrt(dx * dx + dy * dy) / (rect.width / 2))
    onChange({
      hue: Math.round((ang / 360) * 255) % 256,
      sat: Math.round(s * 255),
      value,
    })
  }

  const useEyedropper = async () => {
    const Ctor = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } })
      .EyeDropper
    if (!Ctor) return
    try {
      const res = await new Ctor().open()
      const hsv = hexToHsv(res.sRGBHex)
      if (hsv) onChange({ hue: hsv.hue, sat: hsv.sat, value })
    } catch {
      /* 用户取消，忽略 */
    }
  }

  const commitHex = (text: string) => {
    const hsv = hexToHsv(text)
    if (!hsv) {
      setHexBad(true)
      return
    }
    setHexBad(false)
    onChange({ hue: hsv.hue, sat: hsv.sat, value })
    onDone?.()
  }

  const angle = (hue / 255) * 360
  const radius = (sat / 255) * 50
  const markX = 50 + radius * Math.cos((angle * Math.PI) / 180)
  const markY = 50 + radius * Math.sin((angle * Math.PI) / 180)
  const solid = hsvToHex(hue, sat, value)

  return (
    <div className={`color-picker ${disabled ? 'disabled' : ''}`}>
      <div className="color-wheel" style={{ width: size, height: size }}>
        <canvas
          ref={canvasRef}
          style={{ width: size, height: size }}
          onPointerDown={(e) => {
            if (disabled) return
            draggingRef.current = true
            e.currentTarget.setPointerCapture(e.pointerId)
            pickAt(e)
          }}
          onPointerMove={(e) => {
            if (!draggingRef.current || disabled) return
            pickAt(e)
          }}
          onPointerUp={(e) => {
            if (!draggingRef.current) return
            draggingRef.current = false
            e.currentTarget.releasePointerCapture(e.pointerId)
            onDone?.()
          }}
          onPointerCancel={() => {
            draggingRef.current = false
            onDone?.()
          }}
        />
        <span className="color-wheel-dot" style={{ left: `${markX}%`, top: `${markY}%` }} />
      </div>

      <div className="color-controls">
        <div className="color-value-row">
          <span className="color-preview" style={{ background: solid }} />
          <div className="color-value-slider">
            <input
              type="range"
              min={0}
              max={255}
              value={value}
              disabled={disabled}
              aria-label="明度"
              style={{
                background: `linear-gradient(90deg, #000, ${hsvToHex(hue, sat, 255)})`,
              }}
              onChange={(e) => onChange({ hue, sat, value: Number(e.target.value) })}
              onPointerUp={() => onDone?.()}
              onKeyUp={() => onDone?.()}
            />
            <span className="color-value-num mono">明度 {value}</span>
          </div>
        </div>

        <div className="color-hex-row">
          <input
            className={`hex-input mono ${hexBad ? 'invalid' : ''}`}
            value={hexText}
            disabled={disabled}
            spellCheck={false}
            onChange={(e) => setHexText(e.target.value)}
            onBlur={(e) => commitHex(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitHex((e.target as HTMLInputElement).value)
            }}
          />
          <button
            className="btn ghost small"
            disabled={disabled || !eyeOk}
            title={eyeOk ? '从屏幕上任意位置吸取颜色' : '当前系统不支持屏幕取色'}
            onClick={() => void useEyedropper()}
          >
            吸管
          </button>
        </div>
      </div>
    </div>
  )
}
