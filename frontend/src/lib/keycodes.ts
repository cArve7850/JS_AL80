/** QMK keycode 名称表与格式化（VIA 传的是 16 位 keycode，大端） */

export const KC_NONE = 0x0000
export const KC_TRNS = 0x0001

export const QK_MO = 0x5220 // MO(layer)
export const QK_DF = 0x5240 // DF(layer)
export const QK_TG = 0x5260 // TG(layer)
export const QK_OSL = 0x5280 // OSL(layer)
export const QK_TT = 0x52c0 // TT(layer)
export const QK_LT = 0x4000 // LT(layer, kc)
export const QK_MACRO = 0x7700 // M0..M15
export const QK_KB = 0x7e00 // 自定义键码起点（KC_USB = QK_KB + 0）

type Entry = [number, string]

const TABLE: Entry[] = [
  [0x0004, 'A'], [0x0005, 'B'], [0x0006, 'C'], [0x0007, 'D'], [0x0008, 'E'],
  [0x0009, 'F'], [0x000a, 'G'], [0x000b, 'H'], [0x000c, 'I'], [0x000d, 'J'],
  [0x000e, 'K'], [0x000f, 'L'], [0x0010, 'M'], [0x0011, 'N'], [0x0012, 'O'],
  [0x0013, 'P'], [0x0014, 'Q'], [0x0015, 'R'], [0x0016, 'S'], [0x0017, 'T'],
  [0x0018, 'U'], [0x0019, 'V'], [0x001a, 'W'], [0x001b, 'X'], [0x001c, 'Y'],
  [0x001d, 'Z'],
  [0x001e, '1'], [0x001f, '2'], [0x0020, '3'], [0x0021, '4'], [0x0022, '5'],
  [0x0023, '6'], [0x0024, '7'], [0x0025, '8'], [0x0026, '9'], [0x0027, '0'],
  [0x0028, 'Enter'], [0x0029, 'Esc'], [0x002a, 'Backspace'], [0x002b, 'Tab'],
  [0x002c, 'Space'], [0x002d, '-'], [0x002e, '='], [0x002f, '['], [0x0030, ']'],
  [0x0031, '\\'], [0x0033, ';'], [0x0034, "'"], [0x0035, '`'], [0x0036, ','],
  [0x0037, '.'], [0x0038, '/'], [0x0039, 'Caps Lock'],
  [0x003a, 'F1'], [0x003b, 'F2'], [0x003c, 'F3'], [0x003d, 'F4'], [0x003e, 'F5'],
  [0x003f, 'F6'], [0x0040, 'F7'], [0x0041, 'F8'], [0x0042, 'F9'], [0x0043, 'F10'],
  [0x0044, 'F11'], [0x0045, 'F12'],
  [0x0046, 'Print Screen'], [0x0047, 'Scroll Lock'], [0x0048, 'Pause'],
  [0x0049, 'Insert'], [0x004a, 'Home'], [0x004b, 'Page Up'], [0x004c, 'Delete'],
  [0x004d, 'End'], [0x004e, 'Page Down'], [0x004f, '→'], [0x0050, '←'],
  [0x0051, '↓'], [0x0052, '↑'],
  [0x0053, 'Num Lock'], [0x0054, 'KP /'], [0x0055, 'KP *'], [0x0056, 'KP -'],
  [0x0057, 'KP +'], [0x0058, 'KP Enter'], [0x0059, 'KP 1'], [0x005a, 'KP 2'],
  [0x005b, 'KP 3'], [0x005c, 'KP 4'], [0x005d, 'KP 5'], [0x005e, 'KP 6'],
  [0x005f, 'KP 7'], [0x0060, 'KP 8'], [0x0061, 'KP 9'], [0x0062, 'KP 0'],
  [0x0063, 'KP .'], [0x0064, '\\ (ISO)'], [0x0065, 'Menu'],
  [0x00e0, 'Left Ctrl'], [0x00e1, 'Left Shift'], [0x00e2, 'Left Alt'],
  [0x00e3, 'Left Win'], [0x00e4, 'Right Ctrl'], [0x00e5, 'Right Shift'],
  [0x00e6, 'Right Alt'], [0x00e7, 'Right Win'],
  [0x00a5, 'System Power'], [0x00a6, 'System Sleep'], [0x00a7, 'System Wake'],
  [0x00a8, '静音'], [0x00a9, '音量 +'], [0x00aa, '音量 -'],
  [0x00ab, '下一曲'], [0x00ac, '上一曲'], [0x00ad, '停止'],
  [0x00ae, '播放/暂停'], [0x00af, '媒体选择'], [0x00b0, '弹出'],
  [0x00b1, '邮件'], [0x00b2, '计算器'], [0x00b3, '我的电脑'],
  [0x00b4, '浏览器搜索'], [0x00b5, '浏览器主页'], [0x00b6, '浏览器后退'],
  [0x00b7, '浏览器前进'], [0x00b8, '浏览器停止'], [0x00b9, '浏览器刷新'],
  [0x00ba, '浏览器收藏'], [0x00bb, '快进'], [0x00bc, '快退'],
  [0x00bd, '亮度 +'], [0x00be, '亮度 -'],
]

const NAME_BY_CODE = new Map<number, string>(TABLE)
const CODE_BY_NAME = new Map<string, number>(
  TABLE.map(([code, name]) => [name.toLowerCase(), code]),
)

export const BASIC_KEYS = TABLE.filter(([c]) => c < 0x00e0 && c >= 0x0004)
export const MEDIA_KEYS = TABLE.filter(([c]) => c >= 0x00a5 && c < 0x00e0)
export const MODIFIER_KEYS = TABLE.filter(([c]) => c >= 0x00e0)

/** 自定义键码（VIA customKeycodes）：KC_USB = USB MODE */
export const CUSTOM_KEYS: { code: number; name: string; note?: string }[] = [
  { code: QK_KB, name: 'USB MODE', note: 'VIA 自定义键码 KC_USB，序号若不符请在「自定义」里直接填' },
]

export function kcName(kc: number): string {
  if (kc === KC_NONE) return '无'
  if (kc === KC_TRNS) return '▽'
  const direct = NAME_BY_CODE.get(kc)
  if (direct) return direct

  if (kc >= QK_LT && kc < QK_LT + 0x1000) {
    const layer = (kc >> 8) & 0x0f
    const inner = kc & 0xff
    return `LT(${layer},${kcName(inner)})`
  }
  if (kc >= QK_MO && kc < QK_MO + 0x20) return `MO(${kc & 0x1f})`
  if (kc >= QK_DF && kc < QK_DF + 0x20) return `DF(${kc & 0x1f})`
  if (kc >= QK_TG && kc < QK_TG + 0x20) return `TG(${kc & 0x1f})`
  if (kc >= QK_OSL && kc < QK_OSL + 0x20) return `OSL(${kc & 0x1f})`
  if (kc >= QK_TT && kc < QK_TT + 0x20) return `TT(${kc & 0x1f})`
  if (kc >= QK_MACRO && kc < QK_MACRO + 0x10) return `M${kc - QK_MACRO}`
  if (kc >= QK_KB && kc < QK_KB + 0x20) {
    const idx = kc - QK_KB
    const custom = CUSTOM_KEYS[idx]
    return custom ? custom.name : `KB(${idx})`
  }
  return '0x' + kc.toString(16).toUpperCase().padStart(4, '0')
}

export function parseKc(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16)
  if (/^\d+$/.test(t)) return parseInt(t, 10)
  const byName = CODE_BY_NAME.get(t.toLowerCase())
  if (byName !== undefined) return byName
  const macroFn = /^M(\d+)$/i.exec(t)
  if (macroFn) {
    const n = Number(macroFn[1])
    if (n < 16) return QK_MACRO + n
  }
  const layerFn = /^(MO|DF|TG|OSL|TT)\((\d+)\)$/i.exec(t)
  if (layerFn) {
    const base = { MO: QK_MO, DF: QK_DF, TG: QK_TG, OSL: QK_OSL, TT: QK_TT }[
      layerFn[1].toUpperCase() as 'MO'
    ]
    return base + Number(layerFn[2])
  }
  return null
}

export function isLayerKey(kc: number): boolean {
  return kc >= QK_MO && kc < QK_TT + 0x20
}
