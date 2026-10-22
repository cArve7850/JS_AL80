import { useCallback, useEffect, useRef, useState } from 'react'
import DiagnosticModal from './components/DiagnosticModal'
import SelfCheckModal from './components/SelfCheckModal'
import KbPanel from './components/KbPanel'
import StatusBar from './components/StatusBar'
import { runReset, runSave, useKbState } from './lib/kbStore'
import FirstRun, { hasOnboarded } from './components/FirstRun'
import { ToastProvider, useToast } from './components/Toast'
import { loadScreenConfig, saveScreenConfig, type ScreenProtocolConfig } from './config/screen.config'
import KeymapPage from './pages/Keymap'
import MacrosPage from './pages/Macros'
import LightingPage from './pages/Lighting'
import ScreenPage from './pages/Screen'
import { api, isNative, onEvent, type DeviceStatus } from './lib/bridge'

/** 导出/导入的配置文件结构 */
interface ConfigFile {
  app?: string
  version?: string
  exportedAt?: string
  screenConfig?: ScreenProtocolConfig
  status?: Record<string, unknown> | null
  keymap?: { rows: number; cols: number; layers: number[][] } | null
  lighting?: { brightness?: number; effect?: number; speed?: number; hue?: number; sat?: number } | null
  macros?: string[] | null
}
type Tab = 'keymap' | 'lighting' | 'screen' | 'macro'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'keymap', label: '按键设置', icon: '⌨' },
  { id: 'lighting', label: '灯光设置', icon: '☀' },
  { id: 'screen', label: '屏幕设置', icon: '▤' },
  { id: 'macro', label: '键盘宏', icon: '✎' },
]

function Shell() {
  const toast = useToast()
  const kb = useKbState()
  const [tab, setTab] = useState<Tab>('keymap')
  const [status, setStatus] = useState<DeviceStatus | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [diagOpen, setDiagOpen] = useState(false)
  const [checkOpen, setCheckOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [version, setVersion] = useState('0.1.0')
  const [tilt, setTiltState] = useState<boolean>(() => localStorage.getItem('al80.kbTilt') !== '0')
  const greeted = useRef(false)

  const setTilt = (v: boolean | ((prev: boolean) => boolean)) => {
    setTiltState((prev) => {
      const next = typeof v === 'function' ? v(prev) : v
      localStorage.setItem('al80.kbTilt', next ? '1' : '0')
      return next
    })
  }

  const connect = useCallback(
    async (silent = false) => {
      setConnecting(true)
      try {
        const st = await api.autoConnect()
        setStatus(st)
        if (st.connected) {
          if (!silent || !greeted.current) {
            toast.push('ok', `已连接 ${st.product}（${st.kindLabel}），可开始改键`)
            greeted.current = true
          }
        } else if (!silent) {
          toast.push('err', st.lastError || '未检测到 AL80')
        }
      } catch (e) {
        if (!silent) toast.push('err', `连接失败：${(e as Error).message}`)
      } finally {
        setConnecting(false)
      }
    },
    [toast],
  )

  useEffect(() => {
    if (!isNative()) {
      toast.push('err', '原生接口未就绪：请从 al80-studio.exe 启动')
      return
    }
    void api.version().then(setVersion).catch(() => {})
    void api.status().then((st) => {
      setStatus(st)
      if (st.connected) greeted.current = true
    })
    // 第一次打开时弹引导（等状态回来再判断，避免"已连接"显示错）
    if (!hasOnboarded()) window.setTimeout(() => setGuideOpen(true), 600)
    const off = onEvent<DeviceStatus>('device:changed', (st) => {
      setStatus(st)
      if (st.connected && !greeted.current) {
        greeted.current = true
        toast.push('ok', `已连接 ${st.product}（${st.kindLabel}），可开始改键`)
      } else if (!st.connected) {
        greeted.current = false
        if (st.lastError) toast.push('warn', st.lastError)
      }
    })
    void connect(true)
    return off
  }, [connect, toast])

  const disconnect = async () => {
    try {
      const st = await api.disconnect()
      setStatus(st)
      toast.push('info', '已断开')
    } catch (e) {
      toast.push('err', (e as Error).message)
    }
  }

  const exportConfig = async () => {
    // 连上时把键位/灯光/宏一起读出来，做成一个完整快照
    let keymap: { rows: number; cols: number; layers: number[][] } | null = null
    let macros: string[] | null = null
    let lighting: { brightness?: number; effect?: number; speed?: number; hue?: number; sat?: number } | null =
      null
    if (status?.connected) {
      try {
        const km = await api.readKeymap()
        keymap = { rows: km.rows, cols: km.cols, layers: km.layers }
      } catch {
        /* 读不到就留 null，导出文件里记为 null */
      }
      try {
        const m = await api.readMacros()
        macros = (m.slots ?? []).map((s) => s.text)
      } catch {
        /* 同上 */
      }
      try {
        lighting = await api.readLighting()
      } catch {
        /* 同上 */
      }
    }
    const payload = {
      app: 'al80-studio',
      version,
      exportedAt: new Date().toISOString(),
      screenConfig: loadScreenConfig(),
      status: status
        ? {
            product: status.product,
            vid: status.vid,
            pid: status.pid,
            kind: status.kindLabel,
            protocolVersion: status.protocolVersion,
            layerCount: status.layerCount,
          }
        : null,
      keymap,
      lighting,
      macros,
    }
    try {
      const path = await api.exportConfig(JSON.stringify(payload, null, 2))
      if (path) {
        const parts = ['屏幕参数']
        if (keymap) parts.push(`${keymap.layers.length} 层键位`)
        if (lighting) parts.push('灯光')
        if (macros) parts.push('宏')
        toast.push('ok', `已导出 ${parts.join('、')} 到 ${path}`)
      }
    } catch (e) {
      toast.push('err', `导出失败：${(e as Error).message}`)
    }
  }

  const importConfig = async () => {
    try {
      const text = await api.importConfig()
      if (!text) return
      const data = JSON.parse(text) as ConfigFile
      const done: string[] = []

      if (data.screenConfig) {
        saveScreenConfig({ ...loadScreenConfig(), ...data.screenConfig })
        done.push('屏幕参数')
      }

      if (status?.connected) {
        if (Array.isArray(data.macros) && data.macros.length > 0) {
          await api.saveMacros(data.macros)
          done.push(`宏 ${data.macros.filter((m) => m.trim()).length} 条`)
        }
        if (data.lighting && typeof data.lighting === 'object') {
          const L = data.lighting
          await api.applyLighting(
            L.brightness ?? -1,
            L.effect ?? -1,
            L.speed ?? -1,
            L.hue ?? -1,
            L.sat ?? -1,
          )
          done.push('灯光')
        }
        if (data.keymap?.layers?.length) {
          const cur = await api.readKeymap()
          const changes: { layer: number; row: number; col: number; keycode: number }[] = []
          const layers = Math.min(data.keymap.layers.length, cur.layers.length)
          for (let l = 0; l < layers; l++) {
            const want = data.keymap.layers[l] ?? []
            const have = cur.layers[l] ?? []
            const n = Math.min(want.length, have.length)
            for (let i = 0; i < n; i++) {
              if (want[i] !== have[i]) {
                changes.push({ layer: l, row: Math.floor(i / cur.cols), col: i % cur.cols, keycode: want[i] })
              }
            }
          }
          if (changes.length > 0) {
            const applied = await api.applyKeymap(changes)
            done.push(`键位 ${applied} 处`)
          }
        }
      }

      window.dispatchEvent(new CustomEvent('al80:config-applied'))
      if (done.length === 0) {
        toast.push('warn', '文件里没有可识别的配置段')
      } else {
        toast.push('ok', `已导入：${done.join('、')}`)
      }
    } catch (e) {
      toast.push('err', `导入失败：${(e as Error).message}`)
    }
  }

  const resetAll = async () => {
    try {
      await api.disconnect()
      setStatus((prev) => (prev ? { ...prev, connected: false } : prev))
    } catch {
      /* ignore */
    }
    toast.push('info', '已断开设备。各页面的「恢复默认」可重置该页参数')
  }

  return (
    <div className="app">
      <StatusBar
        status={status}
        connecting={connecting}
        version={version}
        tilt={tilt}
        onToggleTilt={() => setTilt((v) => !v)}
        onReconnect={() => void connect(false)}
        onDisconnect={() => void disconnect()}
        onDiagnose={() => setDiagOpen(true)}
        onSelfCheck={() => setCheckOpen(true)}
        onGuide={() => setGuideOpen(true)}
        onExport={() => void exportConfig()}
        onImport={() => void importConfig()}
        onResetAll={() => void resetAll()}
      />

      {!status?.connected && (
        <div className="top-banner">
          <span>未连接键盘</span>
          <button className="linkbtn" onClick={() => void connect(false)}>
            点这里重试连接
          </button>
        </div>
      )}

      <KbPanel connected={Boolean(status?.connected)} tilt={tilt} />

      {/* 下半部分：左侧竖排模块切换，右侧模块内容 */}
      <div className="lower">
        <aside className="sidebar">
          <nav className="side-nav">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`side-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <span className="side-tab-icon">{t.icon}</span>
                <span className="side-tab-label">{t.label}</span>
              </button>
            ))}
          </nav>

          <div className="side-actions">
            <button
              className="btn ghost"
              onClick={() => runReset(tab)}
              disabled={!status?.connected || kb.savingBy !== null}
            >
              恢复默认
            </button>
            <button
              className="btn primary"
              onClick={() => runSave(tab)}
              disabled={!status?.connected || kb.savingBy !== null}
            >
              {kb.savingBy ? '写入中…' : '保存到键盘'}
            </button>
          </div>
        </aside>

        <main className="content">
          {/* 四页都保持挂载：左侧「恢复默认 / 保存到键盘」在任意模块都能用 */}
          <div className="pane" hidden={tab !== 'keymap'}>
            <KeymapPage
              status={status}
              active={tab === 'keymap'}
              onNeedConnect={() => void connect(false)}
            />
          </div>
          <div className="pane" hidden={tab !== 'lighting'}>
            <LightingPage status={status} />
          </div>
          <div className="pane" hidden={tab !== 'screen'}>
            <ScreenPage status={status} onNeedConnect={() => void connect(false)} />
          </div>
          <div className="pane" hidden={tab !== 'macro'}>
            <MacrosPage status={status} onNeedConnect={() => void connect(false)} />
          </div>
        </main>
      </div>

      <DiagnosticModal open={diagOpen} onClose={() => setDiagOpen(false)} />
      <SelfCheckModal open={checkOpen} onClose={() => setCheckOpen(false)} />
      <FirstRun
        open={guideOpen}
        connected={Boolean(status?.connected)}
        product={status?.product}
        onClose={() => setGuideOpen(false)}
      />
    </div>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}
