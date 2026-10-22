/**
 * AL80 配列（来自 AL80_QMK_V0103_20241128 驱动文件.json 的 layouts.keymap）
 * 6 行 × 15 列矩阵，80 个按键位置 + 1 个旋钮（encoder 0，位于右上角 0,14）。
 * 如果实机配列与此不符，只改这个文件。
 */
export interface KeySpot {
  /** "行,列"，与 VIA keymap 坐标一一对应 */
  id: string
  row: number
  col: number
  x: number
  y: number
  w: number
}

type Token = string | { w?: number; x?: number }

export const MATRIX_ROWS = 6
export const MATRIX_COLS = 15
export const ENCODER_COUNT = 1

const ROW_TOKENS: Token[][] = [
  [
    // F 排：实测每组之间键帽边缘的空隙是 4mm（VIA 原来给 0.25u，绘出来是 5.5mm）。
    // 键帽比格子窄 0.71mm，所以格距只加 (4 - 0.71) / 19.15 = 0.1718u。
    // Esc 仍顶到最左；Del 之后多出 0.3128u（6mm）留成 Del 和旋钮之间的缝，
    // 旋钮仍落在 15–16u（和下面 PgDn、小屏幕同一竖线）。
    '0,0',
    { x: 0.1718 }, '0,1', '0,2', '0,3', '0,4',
    { x: 0.1718 }, '0,5', '0,6', '0,7', '0,8',
    { x: 0.1718 }, '0,9', '0,10', '0,11', '0,12',
    { x: 0.1718 }, '0,13',
    { x: 0.3128 },
    '0,14',
  ],
  [
    // ANSI 标准：反引号 1u、退格 2u，1 + 12 + 2 + PgUp 1 = 16u
    '1,0', '1,1', '1,2', '1,3', '1,4', '1,5', '1,6', '1,7',
    '1,8', '1,9', '1,10', '1,11', '1,12', { w: 2 }, '1,13', '1,14',
  ],
  [
    // 标准 75%：Tab 1.5u、反斜杠 1.5u（ANSI），1.5 + 12 + 1.5 + PgDn 1 = 16u
    { w: 1.5 }, '2,0', '2,1', '2,2', '2,3', '2,4', '2,5', '2,6', '2,7',
    '2,8', '2,9', '2,10', '2,11',
    // 2,12 = "]" —— 厂商 JSON 的 layouts 里漏了这一格（固件里键码是 0x0030），
    // 实测固件共 80 个键位，所以这里必须补上。
    '2,12',
    // 2,13 = 反斜杠，ANSI 标准 1.5u
    { w: 1.5 }, '2,13', '2,14',
  ],
  [
    // 标准 75%：CapsLock 1.75u、回车 2.25u，1.75 + 11 + 2.25 = 15u（右侧留 1u 给小屏幕）
    { w: 1.75 }, '3,0', '3,1', '3,2', '3,3', '3,4', '3,5', '3,6', '3,7',
    '3,8', '3,9', '3,10', '3,11', { w: 2.25 }, '3,13',
  ],
  [
    { w: 2.25 }, '4,0', '4,2', '4,3', '4,4', '4,5', '4,6', '4,7', '4,8',
    '4,9', '4,10', '4,11', { w: 1.75 }, '4,12', '4,13',
  ],
  [
    { w: 1.25 }, '5,0', { w: 1.25 }, '5,1', { w: 1.25 }, '5,2',
    { w: 6.25 }, '5,6', { w: 1.25 }, '5,10', { w: 1.25 }, '5,11',
    { x: 0.5 }, '5,12', '5,13', '5,14',
  ],
]

function buildLayout(): KeySpot[] {
  const spots: KeySpot[] = []
  ROW_TOKENS.forEach((row, y) => {
    let x = 0
    let w = 1
    for (const token of row) {
      if (typeof token === 'string') {
        const [r, c] = token.split(',').map(Number)
        spots.push({ id: token, row: r, col: c, x, y, w })
        x += w
        w = 1
      } else {
        if (token.x) x += token.x
        if (token.w) w = token.w
      }
    }
  })
  return spots
}

export const AL80_LAYOUT: KeySpot[] = buildLayout()
export const LAYOUT_WIDTH_UNITS = 16
export const KNOB = { row: 0, col: 14, encoderIndex: 0, label: '右上角旋钮' }

export function spotById(id: string): KeySpot | undefined {
  return AL80_LAYOUT.find((s) => s.id === id)
}
