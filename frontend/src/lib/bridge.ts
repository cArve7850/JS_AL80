/** 前端 ↔ Go 原生侧的桥。所有 HID 都在原生侧，前端只调这些方法。 */

export interface Channel {
  path: string
  device: string
  vid: string
  pid: string
  usagePage: number
  usage: number
  usageText: string
  inLen: number
  outLen: number
  featureLen: number
  role: string
  roleLabel: string
  via?: boolean
  note?: string
}

export interface DeviceStatus {
  connected: boolean
  path: string
  product: string
  manufacturer: string
  vid: string
  pid: string
  firmwareVersion: number
  kind: string
  kindLabel: string
  enumerator: string
  protocolVersion: number
  layerCount: number
  macroCount: number
  encoderConfigurable: boolean
  userDisconnected?: boolean
  donglePresent: boolean
  dongleName: string
  screenFound: boolean
  screenUsage: string
  battery: string
  channels: Channel[] | null
  warnings: string[] | null
  lastError: string
}

export interface HidInfo {
  path: string
  vendorId: number
  productId: number
  usagePage: number
  usage: number
  inReportLength: number
  outReportLength: number
  featureReportLength: number
  product: string
  manufacturer: string
  enumerator: string
  deviceDesc: string
  openError?: string
}

export interface KeymapData {
  rows: number
  cols: number
  layers: number[][]
  encoders: [number, number][]
}

export interface KeyChange {
  layer: number
  row: number
  col: number
  keycode: number
}

export interface DiagResult {
  devices: HidInfo[]
  matched: Channel[] | null
  status: DeviceStatus
  reportText: string
}

export interface ScreenParams {
  width: number
  height: number
  fitMode: string
  byteOrder: 'le' | 'be'
  usagePage: number
  usage: number
  reportSize: number
  gapMs: number
  headerTemplate: string
  beginTemplate: string
  endTemplate: string
  chunkDelayMs: number
  ackWaitMs: number
  brightnessSupported: boolean
  brightnessTemplate: string
  displayModes: { id: number; label: string; template: string }[]
}

export interface ScreenPreview {
  dataUrl: string
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
  frames: number
  pixelBytes: number
  chunkCount: number
  payloadPerChunk: number
  hexPreview: string[] | null
  warnings: string[] | null
}

export interface ScreenSendResult {
  chunks: number
  bytes: number
  elapsedMs: number
  warnings: string[] | null
  hexLog: string[] | null
}

/** key:watch 事件负载 */
export interface KeyWatchState {
  active: boolean
  pressed: [number, number][] | null
  error?: string
  rows?: number[]
}

/** 宏槽位 */
export interface MacroSlot {
  index: number
  text: string
  bytes: number
}

/** 宏区信息 */
export interface MacroInfo {
  count: number
  bufferSize: number
  stride: number
  usedBytes: number
  slots: MacroSlot[] | null
}

export interface MacroPreview {
  ok: boolean
  bytes?: number
  hex?: string
  error?: string
}
/** 一项能力自检结果 */
export interface CheckItem {
  name: string
  ok: boolean
  detail: string
  hint?: string
}

/** 能力自检报告 */
export interface SelfCheckReport {
  checks: CheckItem[] | null
  reportText: string
  okCount: number
  failCount: number
}
type GoApp = Record<string, (...args: any[]) => Promise<any>>

function go(): GoApp {
  const g = (window as any)?.go?.main?.App as GoApp | undefined
  if (!g) {
    throw new Error('原生接口未就绪：请从 exe 启动（当前是纯浏览器环境）')
  }
  return g
}

export const api = {
  version: () => go().Version(),
  status: () => go().Status() as Promise<DeviceStatus>,
  autoConnect: () => go().AutoConnect() as Promise<DeviceStatus>,
  connect: (path: string) => go().Connect(path) as Promise<DeviceStatus>,
  readMacros: () => go().ReadMacros() as Promise<MacroInfo>,
  saveMacros: (texts: string[]) => go().SaveMacros(texts) as Promise<void>,
  clearMacros: () => go().ClearMacros() as Promise<void>,
  previewMacro: (text: string) => go().PreviewMacro(text) as Promise<MacroPreview>,
  disconnect: () => go().Disconnect() as Promise<DeviceStatus>,
  scanDevices: () => go().ScanDevices() as Promise<HidInfo[]>,
  diagnose: () => go().Diagnose() as Promise<DiagResult>,
  selfCheck: () => go().SelfCheck() as Promise<SelfCheckReport>,
  saveReport: (content: string) => go().SaveReport(content) as Promise<string>,

  readKeymap: () => go().ReadKeymap() as Promise<KeymapData>,
  setKeycode: (layer: number, row: number, col: number, keycode: number) =>
    go().SetKeycode(layer, row, col, keycode),
  setEncoderKey: (layer: number, clockwise: boolean, keycode: number) =>
    go().SetEncoderKey(layer, clockwise, keycode),
  applyKeymap: (changes: KeyChange[]) =>
    go().ApplyKeymap(changes) as Promise<number>,

  readLighting: () =>
    go().ReadLighting() as Promise<{ brightness?: number; effect?: number; speed?: number; hue?: number; sat?: number }>,
  setLightingValue: (id: number, value: number) => go().SetLightingValue(id, value),
  setLightingColor: (h: number, s: number, v: number) => go().SetLightingColor(h, s, v),
  applyLighting: (brightness: number, effect: number, speed: number, hue: number, sat: number) =>
    go().ApplyLighting(brightness, effect, speed, hue, sat),

  screenPreview: (path: string, params: ScreenParams) =>
    go().ScreenPreview(path, params) as Promise<ScreenPreview>,
  screenSend: (path: string, params: ScreenParams) =>
    go().ScreenSend(path, params) as Promise<ScreenSendResult>,
  screenCommand: (params: ScreenParams, template: string, arg: number) =>
    go().ScreenCommand(params, template, arg),
  screenGifFrames: (path: string, params: ScreenParams) =>
    go().ScreenGifFrames(path, params) as Promise<{ images: string[]; total: number }>,
  debugLog: (msg: string) => go().DebugLog(msg) as Promise<void>,
  screenSendAnimation: (path: string, params: ScreenParams, frameLimit: number, boot: boolean) =>
    go().ScreenSendAnimation(path, params, frameLimit, boot) as Promise<{
      frames: number
      delayMs: number
      bytes: number
      elapsedMs: number
      skipped: number
    }>,

  startKeyWatch: () => go().StartKeyWatch(),
  stopKeyWatch: () => go().StopKeyWatch(),

  pickImage: () => go().PickImage() as Promise<string>,
  exportConfig: (content: string) => go().ExportConfig(content) as Promise<string>,
  importConfig: () => go().ImportConfig() as Promise<string>,
}

/** 订阅原生事件，返回取消函数 */
export function onEvent<T>(name: string, cb: (data: T) => void): () => void {
  const rt = (window as any)?.runtime
  if (!rt?.EventsOn) return () => {}
  const off = rt.EventsOn(name, cb)
  return typeof off === 'function' ? off : () => {}
}

export function isNative(): boolean {
  return Boolean((window as any)?.go?.main?.App)
}
