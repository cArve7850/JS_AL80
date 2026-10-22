/**
 * 灯光配置 —— 名称与索引逐条来自 AL80_QMK_V0103 驱动文件.json 的 Lighting 菜单，
 * 该 JSON 同时确认了 VIA 自定义通道与值 ID：
 *   Brightness      → id_qmk_rgb_matrix_brightness, 3, 1   (0..255)
 *   Effect          → id_qmk_rgb_matrix_effect, 3, 2       (0..24)
 *   Effect Speed    → id_qmk_rgb_matrix_effect_speed, 3, 3  (0..255)
 *   Color           → id_qmk_rgb_matrix_color, 3, 4        (hue, sat)
 * 以上四路已在本机实测：速度/效果/颜色读回一致，亮度读回有 ±1 量化；
 * 0 号「全熄 All Off」下亮度与颜色不生效。
 */
export interface EffectDef {
  id: number
  cn: string
  en: string
}

export const RGB_MATRIX_EFFECTS: EffectDef[] = [
  { id: 0, cn: '全熄', en: 'All Off' },
  { id: 1, cn: '单色', en: 'Solid Color' },
  { id: 2, cn: '上下渐变', en: 'Gradient Up/Down' },
  { id: 3, cn: '左右渐变', en: 'Gradient Left/Right' },
  { id: 4, cn: '呼吸', en: 'Breathing' },
  { id: 5, cn: '饱和度条', en: 'Band Sat.' },
  { id: 6, cn: '亮度条', en: 'Band Val.' },
  { id: 7, cn: '饱和度风车', en: 'Pinwheel Sat.' },
  { id: 8, cn: '亮度条风车', en: 'Pinwheel Val.' },
  { id: 9, cn: '饱和度螺旋', en: 'Spiral Sat.' },
  { id: 10, cn: '亮度条螺旋', en: 'Spiral Val.' },
  { id: 11, cn: '全循环', en: 'Cycle All' },
  { id: 12, cn: '左右循环', en: 'Cycle Left/Right' },
  { id: 13, cn: '上下循环', en: 'Cycle Up/Down' },
  { id: 14, cn: '内外循环', en: 'Cycle Out/In' },
  { id: 15, cn: '内外双循环', en: 'Cycle Out/In Dual' },
  { id: 16, cn: '彩虹', en: 'Rainbow Moving Chevron' },
  { id: 17, cn: '循环风车', en: 'Cycle Pinwheel' },
  { id: 18, cn: '循环螺旋', en: 'Cycle Spiral' },
  { id: 19, cn: '双灯塔', en: 'Dual Beacon' },
  { id: 20, cn: '彩虹灯塔', en: 'Rainbow Beacon' },
  { id: 21, cn: '彩虹风车', en: 'Rainbow Pinwheels' },
  { id: 22, cn: '饱和度呼吸', en: 'Hue Breathing' },
  { id: 23, cn: '饱和度灯摆', en: 'Hue Pendulum' },
  { id: 24, cn: '饱和度波浪', en: 'Hue Wave' },
]

export interface LightingState {
  effect: number
  brightness: number
  speed: number
  hue: number
  sat: number
}

export const LIGHTING_DEFAULTS: LightingState = {
  effect: 1,
  brightness: 210,
  speed: 128,
  hue: 0,
  sat: 255,
}

/** 只有「全熄 All Off」下颜色无意义（实测该模式忽略颜色写入） */
export function colorEnabled(effect: number): boolean {
  return effect !== 0
}

/** 这些模式下速度无意义 */
export function speedEnabled(effect: number): boolean {
  return effect !== 0 && effect !== 1
}

const PRESET_COLORS: { label: string; hue: number; sat: number }[] = [
  { label: '红', hue: 0, sat: 255 },
  { label: '橙', hue: 21, sat: 255 },
  { label: '黄', hue: 42, sat: 255 },
  { label: '绿', hue: 85, sat: 255 },
  { label: '青', hue: 128, sat: 255 },
  { label: '蓝', hue: 170, sat: 255 },
  { label: '紫', hue: 191, sat: 255 },
  { label: '粉', hue: 234, sat: 255 },
  { label: '白', hue: 0, sat: 0 },
]

export { PRESET_COLORS }

export { hsvToCss } from '../lib/color'
