import { useCallback, useEffect, useState } from 'react'
import { api, type DiagResult } from '../lib/bridge'
import { useToast } from './Toast'

interface Props {
  open: boolean
  onClose: () => void
}

export default function DiagnosticModal({ open, onClose }: Props) {
  const [data, setData] = useState<DiagResult | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setData(await api.diagnose())
    } catch (e) {
      toast.push('err', `诊断失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [toast])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  if (!open) return null

  const copy = async () => {
    if (!data) return
    try {
      await navigator.clipboard.writeText(data.reportText)
      toast.push('ok', '诊断报告已复制，粘贴给我即可')
    } catch {
      toast.push('err', '复制失败，请手动全选文本')
    }
  }

  const matched = data?.matched ?? []
  const devices = data?.devices ?? []

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">诊断与设备信息</div>
            <div className="modal-sub">
              这里列出所有 HID 通道。屏幕功能要用的 usage page / 报告长度就看这里。
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => void load()} disabled={busy}>
              {busy ? '扫描中…' : '重新扫描'}
            </button>
            <button className="btn primary" onClick={() => void copy()}>
              复制报告
            </button>
            <button className="btn icon" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="modal-body">
          <section>
            <h4>AL80 相关通道</h4>
            {matched.length === 0 ? (
              <div className="empty-hint">没有发现 AL80 相关通道。请确认键盘已连接（有线优先）。</div>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>设备</th>
                    <th>用途</th>
                    <th>usage page</th>
                    <th>usage</th>
                    <th>IN</th>
                    <th>OUT</th>
                    <th>FEATURE</th>
                  </tr>
                </thead>
                <tbody>
                  {matched.map((c) => (
                    <tr key={c.path + c.usageText}>
                      <td>
                        <div className="cell-dev">{c.device || '—'}</div>
                        <div className="cell-sub mono">{c.vid}:{c.pid}</div>
                      </td>
                      <td>
                        <span className={`tag tag-${c.role.replace('?', '')}`}>
                          {c.roleLabel || c.role}
                        </span>
                        {c.note && <div className="cell-sub">{c.note}</div>}
                      </td>
                      <td className="mono">{c.usageText.split('/')[0]}</td>
                      <td className="mono">{c.usageText.split('/')[1]}</td>
                      <td className="mono">{c.inLen}</td>
                      <td className="mono">{c.outLen}</td>
                      <td className="mono">{c.featureLen}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h4>系统全部 HID 设备（{devices.length}）</h4>
            <div className="scroll-y short">
              <table className="grid small">
                <thead>
                  <tr>
                    <th>VID:PID</th>
                    <th>usage</th>
                    <th>IN/OUT</th>
                    <th>产品</th>
                    <th>枚举器</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((d, i) => (
                    <tr key={d.path + i}>
                      <td className="mono">
                        0x{d.vendorId.toString(16).toUpperCase().padStart(4, '0')}:
                        0x{d.productId.toString(16).toUpperCase().padStart(4, '0')}
                      </td>
                      <td className="mono">
                        0x{d.usagePage.toString(16).toUpperCase()}/0x{d.usage.toString(16).toUpperCase()}
                      </td>
                      <td className="mono">
                        {d.inReportLength}/{d.outReportLength}
                      </td>
                      <td>{d.product || d.deviceDesc || '-'}</td>
                      <td className="mono">{d.enumerator}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h4>报告原文</h4>
            <pre className="report">{data?.reportText ?? '扫描中…'}</pre>
          </section>
        </div>
      </div>
    </div>
  )
}
