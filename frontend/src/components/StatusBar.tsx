import { useEffect, useRef, useState } from 'react'
import type { DeviceStatus } from '../lib/bridge'
import { useKbState } from '../lib/kbStore'

interface Props {
  status: DeviceStatus | null
  connecting: boolean
  version: string
  tilt: boolean
  onToggleTilt: () => void
  onReconnect: () => void
  onDisconnect: () => void
  onDiagnose: () => void
  onSelfCheck: () => void
  onGuide: () => void
  onExport: () => void
  onImport: () => void
  onResetAll: () => void
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === 'ble') {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M7 7l10 10-5 3V4l5 3L7 17" />
      </svg>
    )
  }
  if (kind === '2.4g') {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 18a9 9 0 0 1 18 0" />
        <path d="M7 18a5 5 0 0 1 10 0" />
        <circle cx="12" cy="18" r="1.4" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v9" />
      <path d="M8 6h8" />
      <rect x="8" y="12" width="8" height="8" rx="2" />
    </svg>
  )
}

/** 顶部状态栏：键盘状态、层 / 电量、按键延迟，右侧是视图切换与连接操作 */
export default function StatusBar({
  status,
  connecting,
  version,
  tilt,
  onToggleTilt,
  onReconnect,
  onDisconnect,
  onDiagnose,
  onSelfCheck,
  onGuide,
  onExport,
  onImport,
  onResetAll,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const kb = useKbState()

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const connected = Boolean(status?.connected)
  const warnings = status?.warnings ?? []

  return (
    <header className="statusbar">
      <div className="sb-capsule">
        <span className="sb-item">
          <span className={`status-dot ${connected ? 'on' : ''}`} />
          <span className="sb-kind">
            <KindIcon kind={status?.kind ?? ''} />
            {connected ? status?.kindLabel || '已连接' : '未连接'}
          </span>
        </span>

        <span className="sb-div" />
        <span className="sb-item sb-prod">
          {connected
            ? status?.product || 'AL80'
            : status?.userDisconnected
              ? '已手动断开'
              : status?.donglePresent
                ? status?.dongleName || '检测到 2.4G 接收器'
                : '—'}
        </span>

        {connected && (
          <>
            <span className="sb-div" />
            <span className="sb-item">
              <span className="sb-label">层</span>
              <span className="sb-num mono">{kb.layer + 1}</span>
              <span className="sb-dim mono">/{status?.layerCount ?? '—'}</span>
            </span>
          </>
        )}

        {connected && status?.battery ? (
          <>
            <span className="sb-div" />
            <span className="sb-item">
              <span className="sb-label">电量</span>
              <span className="sb-num mono">{status.battery}</span>
            </span>
          </>
        ) : null}

        <span className="sb-div" />
        <span className="sb-item">
          <span className="sb-label">按键延迟</span>
          <span className="sb-num mono">{kb.detectMs > 0 ? `${kb.detectMs} ms` : '—'}</span>
        </span>

        {kb.rowsMask ? (
          <>
            <span className="sb-div" />
            <span className="sb-item sb-mask">
              <span className="sb-label">矩阵</span>
              <span className="sb-mask-val mono">{kb.rowsMask}</span>
            </span>
          </>
        ) : null}
      </div>

      {warnings.length > 0 && (
        <span className="sb-warn" title={warnings.join('；')}>
          <span className="sb-warn-badge">!</span>
          {warnings[0]}
        </span>
      )}

      <div className="sb-right">
        <div className="sb-seg">
          <button className={`sb-seg-btn ${!tilt ? 'active' : ''}`} onClick={() => tilt && onToggleTilt()}>
            2D
          </button>
          <button className={`sb-seg-btn ${tilt ? 'active' : ''}`} onClick={() => !tilt && onToggleTilt()}>
            3D
          </button>
        </div>

        <button className="sb-btn" onClick={onReconnect} disabled={connecting}>
          {connecting ? '连接中…' : connected ? '重新连接' : '连接设备'}
        </button>
        {connected && (
          <button className="sb-btn" onClick={onDisconnect}>
            断开
          </button>
        )}

        <div className="sb-menu-wrap" ref={ref}>
          <button className="sb-btn sb-icon" onClick={() => setMenuOpen((v) => !v)} title="更多功能">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <circle cx="5" cy="12" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="19" cy="12" r="1.8" />
            </svg>
          </button>
          {menuOpen && (
            <div className="dropdown sb-drop">
              <button onClick={() => { setMenuOpen(false); onDiagnose() }}>诊断与设备信息</button>
              <button onClick={() => { setMenuOpen(false); onSelfCheck() }}>能力自检</button>
              <button onClick={() => { setMenuOpen(false); onGuide() }}>新手引导</button>
              <div className="dd-sep" />
              <button onClick={() => { setMenuOpen(false); onExport() }}>导出配置 (JSON)</button>
              <button onClick={() => { setMenuOpen(false); onImport() }}>导入配置 (JSON)</button>
              <div className="dd-sep" />
              <button className="danger" onClick={() => { setMenuOpen(false); onResetAll() }}>
                恢复默认（全部页面）
              </button>
              <div className="dd-sep" />
              <div className="dd-about">AL80 Studio v{version}</div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
