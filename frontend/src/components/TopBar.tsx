import { useEffect, useRef, useState } from 'react'
import type { DeviceStatus } from '../lib/bridge'

interface Props {
  status: DeviceStatus | null
  connecting: boolean
  version: string
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
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M7 7l10 10-5 3V4l5 3L7 17" />
      </svg>
    )
  }
  if (kind === '2.4g') {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 18a9 9 0 0 1 18 0" />
        <path d="M7 18a5 5 0 0 1 10 0" />
        <circle cx="12" cy="18" r="1.4" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v9" />
      <path d="M8 6h8" />
      <rect x="8" y="12" width="8" height="8" rx="2" />
    </svg>
  )
}

export default function TopBar({
  status,
  connecting,
  version,
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
    <div className="topbar-wrap">
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark">AL</div>
          <div className="brand-text">
            <div className="brand-title">AL80 Studio</div>
            <div className="brand-sub">键盘控制中心</div>
          </div>
        </div>

        <div className={`device-card ${connected ? 'is-on' : 'is-off'}`}>
          <div className="device-main">
            <span className={`status-dot ${connected ? 'on' : ''}`} />
            <span className="device-name">
              {connected
                ? status?.product || 'AL80'
                : status?.userDisconnected
                  ? '已手动断开'
                  : status?.donglePresent
                    ? `检测到 ${status?.dongleName || '2.4G dongle'}`
                    : '未连接设备'}
            </span>
            {connected && (
              <span className="device-kind">
                <KindIcon kind={status?.kind ?? ''} />
                {status?.kindLabel}
              </span>
            )}
          </div>
          <div className="device-meta">
            {connected ? (
              <>
                <span>{status?.vid}:{status?.pid}</span>
                <span>VIA 协议 v{status?.protocolVersion || '?'}</span>
                <span>{status?.layerCount ?? 0} 层</span>
                {status?.battery ? <span>电量 {status.battery}</span> : null}
                <span className="meta-muted" title={status?.screenUsage || '屏幕数据通道'}>
                  屏幕：{status?.screenUsage ? '可用' : '未就绪'}
                </span>
              </>
            ) : (
              <span>
                {status?.userDisconnected
                  ? '你点了「断开」。点「连接设备」恢复；重新插拔键盘也会自动连上'
                  : status?.donglePresent
                    ? '2.4G dongle 不透传 VIA：请插上 USB 线（有线模式）再改键 / 调灯'
                    : '插入 AL80（USB / 2.4G / 蓝牙）后会自动识别，掉线也会自动重连'}
              </span>
            )}
          </div>
        </div>

        <div className="topbar-actions">
          <button className="btn ghost" onClick={onReconnect} disabled={connecting}>
            {connecting ? '连接中…' : connected ? '重新连接' : '连接设备'}
          </button>
          {connected && (
            <button className="btn ghost" onClick={onDisconnect}>
              断开
            </button>
          )}
          <div className="menu-wrap" ref={ref}>
            <button className="btn icon" onClick={() => setMenuOpen((v) => !v)} title="设置">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
              </svg>
            </button>
            {menuOpen && (
              <div className="dropdown">
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    onDiagnose()
                  }}
                >
                  诊断与设备信息
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    onSelfCheck()
                  }}
                >
                  能力自检（这台机器能做什么）
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    onGuide()
                  }}
                >
                  新手引导（怎么用）
                </button>
                <div className="dd-sep" />
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    onExport()
                  }}
                >
                  导出配置 (JSON)
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    onImport()
                  }}
                >
                  导入配置 (JSON)
                </button>
                <div className="dd-sep" />
                <button
                  className="danger"
                  onClick={() => {
                    setMenuOpen(false)
                    onResetAll()
                  }}
                >
                  恢复默认（全部页面）
                </button>
                <div className="dd-sep" />
                <div className="dd-about">AL80 Studio v{version} · 协议参数未确认项见诊断</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="warn-strip">
          {warnings.map((w, i) => (
            <div key={i} className="warn-item">
              <span className="warn-badge">!</span>
              {w}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
