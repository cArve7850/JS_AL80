import { useCallback, useEffect, useState } from 'react'
import { api, type SelfCheckReport } from '../lib/bridge'
import { useToast } from './Toast'

interface Props {
  open: boolean
  onClose: () => void
}

/**
 * 能力自检：逐项跑一遍「这台机器 + 这个固件到底能做什么」。
 * 后端所有探测都是只读的，或者把原值原样写回去，不会改动键盘内容。
 */
export default function SelfCheckModal({ open, onClose }: Props) {
  const toast = useToast()
  const [report, setReport] = useState<SelfCheckReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const run = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setReport(await api.selfCheck())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void run()
  }, [open, run])

  if (!open) return null

  const save = async () => {
    if (!report) return
    try {
      const path = await api.saveReport(report.reportText)
      if (path) toast.push('ok', `报告已保存到 ${path}`)
    } catch (e) {
      toast.push('err', `保存失败：${(e as Error).message}`)
    }
  }

  const copy = async () => {
    if (!report) return
    try {
      await navigator.clipboard.writeText(report.reportText)
      toast.push('ok', '报告已复制到剪贴板')
    } catch {
      toast.push('err', '复制失败，可以用「保存为文件」')
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">能力自检</div>
            <div className="modal-sub">
              逐项实测这台机器上哪些功能能用。探测都是只读的，或把原值写回，不会改你的设置。
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn ghost tiny" onClick={() => void run()} disabled={loading}>
              {loading ? '检测中…' : '重新检测'}
            </button>
            <button className="btn icon" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="modal-body">
          {error && <div className="banner warn">{error}</div>}

          {report && (
            <>
              <div className="check-summary">
                <span className="check-pill ok">可用 {report.okCount} 项</span>
                {report.failCount > 0 && (
                  <span className="check-pill fail">不可用 {report.failCount} 项</span>
                )}
              </div>
              <div className="check-list">
                {(report.checks ?? []).map((c, i) => (
                  <div key={`${c.name}-${i}`} className={`check-row ${c.ok ? 'ok' : 'fail'}`}>
                    <span className="check-mark">{c.ok ? '✓' : '✕'}</span>
                    <div className="check-body">
                      <div className="check-name">{c.name}</div>
                      <div className="check-detail mono">{c.detail}</div>
                      {c.hint && <div className="check-hint">{c.hint}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {!report && loading && <div className="hint">正在检测…</div>}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={() => void copy()} disabled={!report}>
            复制报告
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={!report}>
            保存为文件
          </button>
        </div>
      </div>
    </div>
  )
}
