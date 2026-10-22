/**
 * AL80 屏幕（LCD）通道参数 —— 唯一来源。
 *
 * 全部取值已通过 USB 抓包实测确认（有线连接，厂商工具 MK856.exe 同款数据）：
 *   - 通道：有线设备的 HID 集合 0xFF60 / 0x61（就是 VIA 那条 65 字节通道）
 *   - 帧：65 字节，[0] = report ID 0x06，[1] = 操作码 0x40 开始 / 0x41 数据 / 0x42 结束
 *   - 屏：96 × 160，RGB565 大端，逐行扫描，左上角为原点
 *   - 数据量：96 × 160 × 2 = 30720 字节，每帧带 56 字节 → 548 帧 + 头 3 帧 + 尾 1 帧 = 552 帧
 *   - 时序：开始帧之后固件要擦闪存，必须等约 350ms 再发数据帧，否则整张图会被丢弃
 *   - 数据帧之间不要读回显（会打乱下发），厂商工具全程不读
 */
export type ScreenFitMode = 'contain' | 'cover' | 'stretch'

export interface ScreenDisplayMode {
  id: number
  label: string
  /** 切换显示模式的命令模板；空字符串 = 未确认，禁用该按钮 */
  template: string
  note?: string
}

export interface ScreenProtocolConfig {
  /** 屏宽（像素），实测 96 */
  width: number
  /** 屏高（像素），实测 160 */
  height: number
  /** 字节序，实测大端 */
  byteOrder: 'le' | 'be'
  /** 实测 0xFF60 */
  usagePage: number
  /** 实测 0x61 */
  usage: number
  /** 输出报告长度（含 report ID），实测 65 */
  reportSize: number
  /** 开始帧之后等待闪存擦除的时间（毫秒），实测需要 ~313ms，留余量用 350 */
  gapMs: number
  /** 数据帧之间的间隔（毫秒），厂商约 1ms */
  chunkDelayMs: number
  /** 必须为 0：读回显会打断下发 */
  ackWaitMs: number
  /** 以下字段已废弃，仅为兼容旧配置保留 */
  headerTemplate: string
  beginTemplate: string
  endTemplate: string
  /** 屏幕亮度：厂商 API 里没有亮度函数，固件也不响应，暂不支持 */
  brightnessSupported: boolean
  brightnessTemplate: string
  displayModes: ScreenDisplayMode[]
}

/** 已经实测确认的事实，UI 上直接展示，让用户知道依据 */
export const SCREEN_CONFIRMED = [
  '通道：有线 0xFF60 / 0x61，report ID 0x06（和 VIA 同一条通道）',
  '分辨率：96 × 160，RGB565 大端，每像素 2 字节',
  '一屏数据 30720 字节，分 552 帧下发（每帧 56 字节）',
  '开始帧之后必须等约 350ms（固件擦闪存），否则整张图会被丢掉',
] as const

/** 仍未确认、因此界面上明确禁用的功能 */
export const SCREEN_PENDING = [
  '切换显示模式（厂商命令 SwitchPage 未抓到底层字节）',
  '屏幕亮度（固件无对应命令）',
  'GIF 动图（只能发第一帧）',
  '无线（2.4G）下发：厂商工具实际走接收器，但我们目前只做了有线',
] as const

export const DEFAULT_SCREEN_CONFIG: ScreenProtocolConfig = {
  width: 96,
  height: 160,
  byteOrder: 'be',
  usagePage: 0xff60,
  usage: 0x61,
  reportSize: 65,
  gapMs: 350,
  chunkDelayMs: 1,
  ackWaitMs: 0,
  headerTemplate: '',
  beginTemplate: '',
  endTemplate: '',
  brightnessSupported: false,
  brightnessTemplate: '',
  displayModes: [
    { id: 0, label: '主页面', template: '', note: '命令字节未确认' },
    { id: 1, label: '图片页', template: '', note: '命令字节未确认' },
    { id: 2, label: 'GIF 页', template: '', note: '命令字节未确认' },
  ],
}

const STORAGE_KEY = 'al80.screen.config.v2'

export function loadScreenConfig(): ScreenProtocolConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SCREEN_CONFIG }
    const parsed = JSON.parse(raw) as Partial<ScreenProtocolConfig>
    return { ...DEFAULT_SCREEN_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_SCREEN_CONFIG }
  }
}

export function saveScreenConfig(cfg: ScreenProtocolConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
}

export function resetScreenConfig() {
  localStorage.removeItem(STORAGE_KEY)
}
