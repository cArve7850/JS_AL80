/** 颜色换算：固件用 0..255 的 hue / sat，界面用 HEX 与 CSS。全部纯函数，便于复用与测试。 */

export interface Hsv {
  /** 0..255 */
  hue: number
  /** 0..255 */
  sat: number
  /** 0..255 */
  value: number
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)))

/** HSV(0..255) → RGB(0..255) */
export function hsvToRgb(hue: number, sat: number, value: number): [number, number, number] {
  const h = (hue / 255) * 360
  const s = sat / 255
  const v = value / 255
  const c = v * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = v - c
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

/** RGB(0..255) → HSV(0..255) */
export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return {
    hue: clamp255((h / 360) * 255),
    sat: max === 0 ? 0 : clamp255((d / max) * 255),
    value: clamp255(max * 255),
  }
}

/** HSV → `#rrggbb` */
export function hsvToHex(hue: number, sat: number, value: number): string {
  const [r, g, b] = hsvToRgb(hue, sat, value)
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')
}

/** `#rgb` / `#rrggbb` / `rrggbb` → HSV；非法返回 null */
export function hexToHsv(input: string): Hsv | null {
  let s = input.trim().replace(/^#/, '')
  if (s.length === 3) s = s.split('').map((c) => c + c).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null
  const r = parseInt(s.slice(0, 2), 16)
  const g = parseInt(s.slice(2, 4), 16)
  const b = parseInt(s.slice(4, 6), 16)
  return rgbToHsv(r, g, b)
}

/** HSV → CSS 颜色（用于预览；亮度饱和都按原值展示） */
export function hsvToCss(hue: number, sat: number, value = 255): string {
  return hsvToHex(hue, sat, value)
}
