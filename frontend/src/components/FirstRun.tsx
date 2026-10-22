import { useEffect, useState } from 'react'

// 带版本号：以后引导内容大改时可以换成 v2 让老用户再看一次
const KEY = 'al80.onboarded.v2'

/** 是否已经看过新手引导 */
export function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return true
  }
}

export function markOnboarded() {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    /* 隐身模式等情况下忽略 */
  }
}

export function resetOnboarding() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 忽略 */
  }
}

interface Props {
  open: boolean
  connected: boolean
  product?: string
  onClose: () => void
}

const STEPS = [
  {
    icon: '🔌',
    title: '先用 USB 线连上键盘',
    body: '改键、调灯都要走 USB 有线。2.4G 接收器和蓝牙只负责打字，键盘不在这两种模式下接受配置。插上后左上角会显示「AL80 Keyboard」，不用点任何按钮。',
  },
  {
    icon: '⌨',
    title: '按键页：点一个键，选新功能',
    body: '点键盘图上任意键帽，右边弹出可选功能（基础键 / 媒体键 / 层 / 宏 / 自定义）。改完记得点右下角「应用到键盘」—— 不点是不会写进键盘的，这样你随时可以反悔。',
  },
  {
    icon: '☀',
    title: '灯光页：选灯效、亮度、颜色',
    body: '选好灯效和颜色后点「应用到键盘」立刻生效。这个固件不支持把灯效存进键盘，断电后会回到默认灯效。',
  },
  {
    icon: '⚙',
    title: '右上角齿轮：备份与排错',
    body: '「导出配置」可以把键位、灯光、宏存成一个 JSON 文件；换电脑或重装后「导入配置」一键还原。真出问题时点「能力自检」，一屏看清这台机器上哪些功能能用。',
  },
]

/**
 * 首次运行引导。只在第一次打开时出现，之后可从齿轮菜单手动打开。
 */
export default function FirstRun({ open, connected, product, onClose }: Props) {
  const [step, setStep] = useState(0)
  const [dontShow, setDontShow] = useState(true)

  useEffect(() => {
    if (open) setStep(0)
  }, [open])

  if (!open) return null

  const last = step === STEPS.length - 1
  const s = STEPS[step]

  const close = () => {
    if (dontShow) markOnboarded()
    onClose()
  }

  return (
    <div className="modal-mask">
      <div className="modal narrow onboard" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">欢迎使用 AL80 Studio</div>
            <div className="modal-sub">
              这是给 YUNZII AL80 用的改键 / 调灯工具，不用装驱动，双击就能用。
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn icon" onClick={close} title="关闭">
              ✕
            </button>
          </div>
        </div>

        <div className="modal-body">
          <div className={`onboard-status ${connected ? 'ok' : 'wait'}`}>
            <span className={`status-dot ${connected ? 'on' : ''}`} />
            {connected
              ? `已连上 ${product || 'AL80 Keyboard'}，可以开始了`
              : '还没检测到键盘 —— 插上 USB 线后这里会立刻变化，不用刷新'}
          </div>

          <div className="onboard-step">
            <div className="onboard-icon">{s.icon}</div>
            <div>
              <div className="onboard-title">
                <span className="onboard-index">
                  {step + 1}/{STEPS.length}
                </span>
                {s.title}
              </div>
              <p className="onboard-body">{s.body}</p>
            </div>
          </div>

          <div className="onboard-dots">
            {STEPS.map((_, i) => (
              <button
                key={i}
                className={`onboard-dot ${i === step ? 'active' : ''}`}
                onClick={() => setStep(i)}
                title={`第 ${i + 1} 步`}
              />
            ))}
          </div>
        </div>

        <div className="modal-foot">
          <label className="onboard-check">
            <input
              type="checkbox"
              checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
            />
            下次不再自动显示（之后可在齿轮菜单里打开）
          </label>
          <div className="onboard-nav">
            {step > 0 && (
              <button className="btn ghost" onClick={() => setStep((v) => v - 1)}>
                上一步
              </button>
            )}
            {last ? (
              <button className="btn primary" onClick={close}>
                开始使用
              </button>
            ) : (
              <button className="btn primary" onClick={() => setStep((v) => v + 1)}>
                下一步
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
