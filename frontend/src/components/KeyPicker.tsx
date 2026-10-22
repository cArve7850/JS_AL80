import { useMemo, useState } from 'react'
import {
  BASIC_KEYS,
  CUSTOM_KEYS,
  MEDIA_KEYS,
  MODIFIER_KEYS,
  KC_NONE,
  KC_TRNS,
  QK_DF,
  QK_MACRO,
  QK_MO,
  QK_OSL,
  QK_TG,
  kcName,
  parseKc,
} from '../lib/keycodes'

interface Props {
  open: boolean
  title: string
  current: number
  layerCount: number
  onPick: (keycode: number) => void
  onClose: () => void
}

type Tab = 'basic' | 'media' | 'layer' | 'macro' | 'custom'

export default function KeyPicker({ open, title, current, layerCount, onPick, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('basic')
  const [query, setQuery] = useState('')
  const [raw, setRaw] = useState('')

  const layers = Math.max(1, Math.min(layerCount || 4, 16))

  const list = useMemo(() => {
    const src = tab === 'basic' ? [...BASIC_KEYS, ...MODIFIER_KEYS] : tab === 'media' ? MEDIA_KEYS : []
    const q = query.trim().toLowerCase()
    if (!q) return src
    return src.filter(([, name]) => name.toLowerCase().includes(q) || kcName(0).includes(q))
  }, [tab, query])

  if (!open) return null

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{title}</div>
            <div className="modal-sub">
              当前：<b className="mono">{kcName(current)}</b>（0x{current.toString(16).toUpperCase().padStart(4, '0')}）
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn icon" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="tabs small">
          {(
            [
              ['basic', '基础键'],
              ['media', '媒体键'],
              ['layer', '层 / 功能'],
              ['macro', '宏'],
              ['custom', '自定义'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {(tab === 'basic' || tab === 'media') && (
            <>
              <input
                className="input"
                placeholder="搜索键名，例如 Enter / F5 / 音量"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="key-grid">
                {list.map(([code, name]) => (
                  <button
                    key={code}
                    className={`keychip ${current === code ? 'active' : ''}`}
                    onClick={() => onPick(code)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </>
          )}

          {tab === 'layer' && (
            <>
              <div className="picker-group">
                <div className="picker-label">按下时临时切到某层（MO）</div>
                <div className="key-grid">
                  {Array.from({ length: layers }, (_, i) => (
                    <button
                      key={`mo${i}`}
                      className={`keychip ${current === QK_MO + i ? 'active' : ''}`}
                      onClick={() => onPick(QK_MO + i)}
                    >
                      MO({i})
                    </button>
                  ))}
                </div>
              </div>
              <div className="picker-group">
                <div className="picker-label">切换层并保持（TG）</div>
                <div className="key-grid">
                  {Array.from({ length: layers }, (_, i) => (
                    <button
                      key={`tg${i}`}
                      className={`keychip ${current === QK_TG + i ? 'active' : ''}`}
                      onClick={() => onPick(QK_TG + i)}
                    >
                      TG({i})
                    </button>
                  ))}
                </div>
              </div>
              <div className="picker-group">
                <div className="picker-label">单次切层（OSL）/ 默认层（DF）</div>
                <div className="key-grid">
                  {Array.from({ length: layers }, (_, i) => (
                    <button
                      key={`osl${i}`}
                      className={`keychip ${current === QK_OSL + i ? 'active' : ''}`}
                      onClick={() => onPick(QK_OSL + i)}
                    >
                      OSL({i})
                    </button>
                  ))}
                  {Array.from({ length: layers }, (_, i) => (
                    <button
                      key={`df${i}`}
                      className={`keychip ${current === QK_DF + i ? 'active' : ''}`}
                      onClick={() => onPick(QK_DF + i)}
                    >
                      DF({i})
                    </button>
                  ))}
                </div>
              </div>
              <div className="picker-group">
                <div className="picker-label">特殊</div>
                <div className="key-grid">
                  <button className={`keychip ${current === KC_NONE ? 'active' : ''}`} onClick={() => onPick(KC_NONE)}>
                    无 (KC_NO)
                  </button>
                  <button className={`keychip ${current === KC_TRNS ? 'active' : ''}`} onClick={() => onPick(KC_TRNS)}>
                    ▽ 透明（继承下层）
                  </button>
                  {CUSTOM_KEYS.map((c) => (
                    <button
                      key={c.code}
                      className={`keychip ${current === c.code ? 'active' : ''}`}
                      onClick={() => onPick(c.code)}
                      title={c.note}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {tab === 'macro' && (
            <>
              <div className="hint">
                选一个宏键码（M0–M15）绑到当前键；宏内容在「按键 → 宏」里编辑。
              </div>
              <div className="key-grid">
                {Array.from({ length: 16 }, (_, i) => (
                  <button
                    key={i}
                    className={`keychip ${current === QK_MACRO + i ? 'active' : ''}`}
                    onClick={() => onPick(QK_MACRO + i)}
                  >
                    M{i}
                  </button>
                ))}
              </div>
            </>
          )}
          {tab === 'custom' && (
            <>
              <div className="field">
                <label>直接填 keycode（支持 0x29、41、Enter、MO(1)）</label>
                <div className="row">
                  <input
                    className="input mono"
                    placeholder="0x0029"
                    value={raw}
                    onChange={(e) => setRaw(e.target.value)}
                  />
                  <button
                    className="btn primary"
                    onClick={() => {
                      const parsed = parseKc(raw)
                      if (parsed === null) return
                      onPick(parsed)
                    }}
                  >
                    使用
                  </button>
                </div>
                <div className="hint">
                  解析结果：<b className="mono">{parseKc(raw) === null ? '—' : kcName(parseKc(raw) as number)}</b>
                </div>
              </div>
              <div className="picker-group">
                <div className="picker-label">自定义键码（VIA customKeycodes）</div>
                {CUSTOM_KEYS.map((c) => (
                  <div key={c.code} className="hint">
                    {c.name} = 0x{c.code.toString(16).toUpperCase()}　{c.note}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
