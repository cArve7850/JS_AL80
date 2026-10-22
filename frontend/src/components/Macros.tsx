import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type MacroInfo } from '../lib/bridge'
import { useToast } from './Toast'
import { markBusy, registerActions } from '../lib/kbStore'

interface Props {
  connected: boolean
  onNeedConnect: () => void
}

const HELP = [
  '直接写要打的字，比如 Hello{enter}',
  '{enter} {esc} {tab} {space} {bspace} {del} {up} {down} {left} {right} {home} {end} {pgup} {pgdn} {ins} {caps} {menu}',
  '{f1}..{f12} {prtsc} {mute} {volup} {voldown} {mplay} {mnext} {mprev}',
  '{delay100} 停 100 毫秒；{ctrl+c} / {ctrl+shift+t} 组合键',
]

export default function Macros({ connected, onNeedConnect }: Props) {
  const toast = useToast()
  const [info, setInfo] = useState<MacroInfo | null>(null)
  const [drafts, setDrafts] = useState<string[]>([])
  const [current, setCurrent] = useState(0)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!connected) return
    setLoading(true)
    setError('')
    try {
      const r = await api.readMacros()
      setInfo(r)
      const slots = r.slots ?? []
      const next = Array.from({ length: r.count || 16 }, (_, i) => slots[i]?.text ?? '')
      setDrafts(next)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [connected])

  useEffect(() => {
    void load()
  }, [load])

  // 导入配置后自动刷新，别让界面显示旧值
  useEffect(() => {
    const h = () => void load()
    window.addEventListener('al80:config-applied', h)
    return () => window.removeEventListener('al80:config-applied', h)
  }, [load])

  const stride = info?.stride || 460
  const used = useMemo(() => drafts.filter((d) => d.trim() !== '').length, [drafts])

  const save = async () => {
    if (!connected) return
    setSaving(true)
    setError('')
    try {
      await api.saveMacros(drafts)
      await load()
      toast.push('ok', '宏已写入键盘（掉电保存由固件负责）')
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      toast.push('err', '写入失败：' + msg)
    } finally {
      setSaving(false)
    }
  }

  // 左侧「保存到键盘」统一入口
  useEffect(() => {
    registerActions('macro', { save: () => void save() })
  })

  useEffect(() => {
    markBusy('macro', saving)
  }, [saving])

  const clearAll = async () => {
    if (!connected) return
    setSaving(true)
    setError('')
    try {
      await api.clearMacros()
      await load()
      toast.push('info', '已清空全部宏')
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      toast.push('err', '清空失败：' + msg)
    } finally {
      setSaving(false)
    }
  }

  if (!connected) {
    return (
      <div className="banner">
        未连接键盘。<button className="linkbtn" onClick={onNeedConnect}>点这里重试连接</button>
      </div>
    )
  }

  const text = drafts[current] ?? ''

  return (
    <div className="macro-area">
      <div className="macro-list">
        <div className="macro-list-head">
          <span>宏槽位</span>
          <span className="mono">{used} / {drafts.length} 已用</span>
        </div>
        {drafts.map((d, i) => (
          <button
            key={i}
            className={`macro-slot ${i === current ? 'active' : ''} ${d.trim() ? 'filled' : ''}`}
            onClick={() => setCurrent(i)}
            title={d || '（空）'}
          >
            <span className="macro-name">M{i}</span>
            <span className="macro-preview">{d.trim() ? d.slice(0, 18) : '空'}</span>
            <span className="macro-len mono">{d ? d.length : 0}</span>
          </button>
        ))}
        <button className="btn ghost tiny" onClick={() => void load()} disabled={loading}>
          {loading ? '读取中…' : '重新读取'}
        </button>
      </div>

      <div className="macro-editor">
        <div className="macro-editor-head">
          <b>M{current}</b>
          <span className="hint">
            文本 {text.length} 字 · 上限约 {stride - 1} 字节（一个字母占 2 字节，大写/符号占 6 字节）
          </span>
        </div>
        <textarea
          className="macro-textarea mono"
          value={text}
          spellCheck={false}
          placeholder="例如：Hello{enter} 或 {ctrl+shift+esc}"
          onChange={(e) => {
            const next = [...drafts]
            next[current] = e.target.value
            setDrafts(next)
          }}
        />
        <div className="macro-help">
          {HELP.map((h) => (
            <div key={h} className="hint">· {h}</div>
          ))}
        </div>
        {error && <div className="banner warn small">{error}</div>}
        <div className="macro-actions">
          <button className="btn ghost" onClick={() => void clearAll()} disabled={saving}>
            清空全部宏
          </button>
        </div>
      </div>
    </div>
  )
}
