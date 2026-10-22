import { useCallback, useEffect, useState } from 'react'
import { useToast } from '../components/Toast'
import {
  DEFAULT_SCREEN_CONFIG,
  loadScreenConfig,
  resetScreenConfig,
  saveScreenConfig,
  type ScreenProtocolConfig,
} from '../config/screen.config'
import { api, onEvent, type DeviceStatus, type ScreenParams, type ScreenPreview } from '../lib/bridge'
import { setScreenImage } from '../lib/screenStore'
import { markBusy, registerActions } from '../lib/kbStore'

interface Props {
  status: DeviceStatus | null
  onNeedConnect: () => void
}

function toParams(cfg: ScreenProtocolConfig, fitMode: string): ScreenParams {
  return {
    width: cfg.width,
    height: cfg.height,
    fitMode,
    byteOrder: cfg.byteOrder,
    usagePage: cfg.usagePage,
    usage: cfg.usage,
    reportSize: cfg.reportSize,
    gapMs: cfg.gapMs,
    chunkDelayMs: cfg.chunkDelayMs,
    ackWaitMs: cfg.ackWaitMs,
    headerTemplate: '',
    beginTemplate: '',
    endTemplate: '',
    brightnessSupported: cfg.brightnessSupported,
    brightnessTemplate: cfg.brightnessTemplate,
    displayModes: cfg.displayModes.map((m) => ({ id: m.id, label: m.label, template: m.template })),
  }
}

// 帧数上限与原厂工具一致：1–60
const gifPathHint = (p: string) => p
const FRAME_MAX = 60
const clampFrames = (v: number | string) => Math.max(1, Math.min(FRAME_MAX, Math.round(Number(v) || 1)))

export default function ScreenPage({ status, onNeedConnect }: Props) {
  const toast = useToast()
  const [cfg, setCfg] = useState<ScreenProtocolConfig>(() => loadScreenConfig())
  const [fitMode, setFitMode] = useState<'contain' | 'cover' | 'stretch'>('contain')
  const [imgPath, setImgPath] = useState('')
  const [preview, setPreview] = useState<ScreenPreview | null>(null)
  const [sending, setSending] = useState(false)
  const [progress, setProgress] = useState({ sent: 0, total: 0 })
  const [showAdvanced, setShowAdvanced] = useState(false)

  const connected = Boolean(status?.connected)

  useEffect(() => {
    saveScreenConfig(cfg)
  }, [cfg])

  useEffect(() => {
    return onEvent<{ sent: number; total: number }>('screen:progress', (p) => setProgress(p))
  }, [])

  const params = useCallback(() => toParams(cfg, fitMode), [cfg, fitMode])

  const pick = async () => {
    try {
      const path = await api.pickImage()
      if (!path) return
      setImgPath(path)
      setPreview(null)
      await previewImage(path)
    } catch (e) {
      toast.push('err', `选择图片失败：${(e as Error).message}`)
    }
  }

  const previewImage = async (path = imgPath) => {
    if (!path) {
      toast.push('info', '先选一张图片')
      return
    }
    try {
      const p = await api.screenPreview(path, params())
      setPreview(p)
      setScreenImage(p?.dataUrl ?? null) // 同步给 3D 模型上的小屏幕
      p.warnings?.forEach((w) => toast.push('warn', w))
    } catch (e) {
      toast.push('err', `预览失败：${(e as Error).message}`)
    }
  }

  const send = async () => {
    if (!connected) return onNeedConnect()
    if (!imgPath) return toast.push('info', '先选一张图片')
    setSending(true)
    setProgress({ sent: 0, total: 0 })
    try {
      const r = await api.screenSend(imgPath, params())
      toast.push('ok', `已上传到屏幕：${r.chunks} 帧 / ${r.bytes} 字节，耗时 ${r.elapsedMs}ms`)
      r.warnings?.forEach((w) => toast.push('warn', w))
    } catch (e) {
      toast.push('err', `上传失败：${(e as Error).message}`)
    } finally {
      setSending(false)
    }
  }

  const resetCfg = () => {
    resetScreenConfig()
    setCfg({ ...DEFAULT_SCREEN_CONFIG })
    setFitMode('contain')
    toast.push('info', '已恢复默认参数，点左侧「保存到键盘」重新上传')
  }

  // 左侧「保存到键盘 / 恢复默认」统一入口
  useEffect(() => {
    registerActions('screen', {
      save: () => void send(),
      reset: () => resetCfg(),
    })
  })

  useEffect(() => {
    markBusy('screen', sending)
  }, [sending])


  const pct = progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0


  // 动图上传（抓包实测：0x12/0x13 宣告 + 每帧 0x10/0x11 头 + 549 个像素帧）
  const [gifPath, setGifPath] = useState('')
  const [frameLimit, setFrameLimit] = useState(FRAME_MAX)
  const [gifFrames, setGifFrames] = useState(0)
  const [aniBusy, setAniBusy] = useState(false)
  const [frames, setFrames] = useState<string[]>([])
  const [gifLoading, setGifLoading] = useState(false)
  const [curFrame, setCurFrame] = useState(0)
  const [playing, setPlaying] = useState(true)
  const pickGif = async () => {
    const path = await api.pickImage()
    if (!path) return
    setGifPath(path)
    setGifLoading(true)
    setCurFrame(0)
    try {
      const pv = await api.screenGifFrames(path, params())
      setFrames(pv.images || [])
      setGifFrames(pv.total || 0)
      setFrameLimit(clampFrames((pv.images || []).length))
      setPlaying(true)
    } catch (e) {
      setFrames([])
      setGifFrames(0)
      // 同时打到日志里，方便排查
      void api.debugLog(`GIF 解析异常 path=${gifPathHint(path)} msg=${String(e)} stack=${(e as Error)?.stack || ''}`)
      toast.push('err', `解析 GIF 失败：${(e as Error).message}`)
    } finally {
      setGifLoading(false)
    }
  }
  // 实时预览：每 120ms 走一帧（和固件下发的帧间隔一致）
  useEffect(() => {
    if (!playing || frames.length < 2) return
    const id = window.setInterval(() => {
      setCurFrame((v) => (v + 1) % frames.length)
    }, 120)
    return () => window.clearInterval(id)
  }, [playing, frames.length])
  // 实际会下发的帧数（不超过已拆出的张数）
  const uploadFrames = Math.max(1, Math.min(frameLimit, frames.length || frameLimit))
  const sendAni = async (boot: boolean) => {
    if (!connected) return onNeedConnect()
    if (!gifPath) return toast.push('info', '先选一个 GIF 动图')
    setAniBusy(true)
    try {
      const r = await api.screenSendAnimation(gifPath, params(), frameLimit, boot)
      const extra = r.skipped > 0 ? `（超出上限跳过 ${r.skipped} 帧）` : ''
      toast.push(
        'ok',
        `${boot ? '开机动画' : '动图'}已上传：${r.frames} 帧 / 间隔 ${r.delayMs}ms / ${(r.bytes / 1024).toFixed(0)}KB / 耗时 ${(r.elapsedMs / 1000).toFixed(1)}s${extra}`,
      )
    } catch (e) {
      toast.push('err', `动图上传失败：${(e as Error).message}`)
    } finally {
      setAniBusy(false)
    }
  }
  // 页面切换（实测：0x0D 是页面索引，1 = 第 1 张图片页，0 = 空页面）
  const [page, setPage] = useState(1)
  const [pageBusy, setPageBusy] = useState(false)
  const switchPage = async (idx: number) => {
    if (!connected) return onNeedConnect()
    setPageBusy(true)
    try {
      await api.screenCommand(params(), 'page', idx)
      setPage(idx)
      toast.push('ok', `已切到第 ${idx} 页`)
    } catch (e) {
      toast.push('err', `切换失败：${(e as Error).message}`)
    } finally {
      setPageBusy(false)
    }
  }
  // 对时（cmd 0x09 时:分:秒 / cmd 0x0A 年高位年低位月日，抓包比对时间戳证实）
  const syncClock = async () => {
    if (!connected) return onNeedConnect()
    try {
      await api.screenCommand(params(), 'clock', 0)
      toast.push('ok', `已把电脑时间 ${new Date().toLocaleTimeString()} 同步到键盘`)
    } catch (e) {
      toast.push('err', `对时失败：${(e as Error).message}`)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>屏幕</h2>
        </div>
        <div className="pill ok" title="屏幕数据走有线 0xFF60/0x61 通道">
          屏幕 96×160
        </div>
      </div>

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h3>动图（GIF）</h3>
            <span className="pill" title="固件支持到 60fps，单次最多 120 帧">单次最多 120 帧</span>
          </div>
          <div className="field">
            <label>动图文件</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn ghost tiny" onClick={() => void pickGif()}>
                选择 GIF
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                {gifPath ? gifPath.split(/[\\/]/).pop() : '未选择'}
              </span>
            </div>
          </div>
          {frames.length > 0 && (
            <>
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ position: 'relative' }}>
                  <img
                    src={frames[Math.min(curFrame, frames.length - 1)]}
                    alt="动图预览"
                    style={{
                      width: 108,
                      height: 180,
                      imageRendering: 'pixelated',
                      borderRadius: 8,
                      border: '1px solid var(--line2)',
                      background: '#000',
                      display: 'block',
                    }}
                  />
                  <span
                    className="pill"
                    style={{ position: 'absolute', left: 5, top: 5, fontSize: 10, padding: '1px 6px' }}
                  >
                    {curFrame + 1}/{frames.length}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220 }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn ghost tiny" onClick={() => setPlaying((v) => !v)}>
                      {playing ? '暂停预览' : '播放预览'}
                    </button>
                    <button className="btn ghost tiny" onClick={() => setCurFrame((v) => Math.max(0, v - 1))}>
                      上一张
                    </button>
                    <button className="btn ghost tiny" onClick={() => setCurFrame((v) => Math.min(frames.length - 1, v + 1))}>
                      下一张
                    </button>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, frames.length - 1)}
                    value={Math.min(curFrame, frames.length - 1)}
                    onChange={(e) => setCurFrame(Number(e.target.value))}
                    style={{ width: '100%', accentColor: 'var(--accent)' }}
                  />
                  <div className="tiny muted" style={{ lineHeight: 1.75 }}>
                    已拆成 <b className="mono">{frames.length}</b> 张照片（每张 96×160 / 30720 字节）
                    <br />
                    合成下发：<b className="mono">{uploadFrames}</b> 帧 / 每帧 120ms / 共{' '}
                    <b className="mono">{Math.round((uploadFrames * 30720) / 1024)}</b> KB / 约{' '}
                    {(uploadFrames * 0.7).toFixed(0)} 秒
                  </div>
                </div>
              </div>
              <div>
                <div className="tiny muted" style={{ marginBottom: 4 }}>
                  拆出的每一张照片（点一下跳到该帧）
                </div>
                <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 6 }}>
                  {frames.map((src, i) => (
                    <img
                      key={i}
                      src={src}
                      alt={`帧${i + 1}`}
                      onClick={() => setCurFrame(i)}
                      style={{
                        width: 34,
                        height: 57,
                        flex: '0 0 auto',
                        imageRendering: 'pixelated',
                        borderRadius: 4,
                        cursor: 'pointer',
                        background: '#000',
                        border: i === curFrame ? '2px solid var(--accent)' : '1px solid var(--line)',
                        opacity: i >= uploadFrames ? 0.3 : 1,
                      }}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="tiny muted" htmlFor="framelimit">帧数</label>
            <input
              id="framelimit"
              type="range"
              min={1}
              max={FRAME_MAX}
              step={1}
              value={frameLimit}
              onChange={(e) => setFrameLimit(clampFrames(e.target.value))}
              title="拖动选择要下发的帧数（与原厂工具一致：1–60）"
              style={{ width: 160, accentColor: 'var(--accent)' }}
            />
            <input
              className="input tiny mono"
              type="number"
              min={1}
              max={FRAME_MAX}
              value={frameLimit}
              onChange={(e) => setFrameLimit(clampFrames(e.target.value))}
              onBlur={(e) => setFrameLimit(clampFrames(e.target.value))}
              title="也可以直接输入：超过 60 按 60 算，小于 1 按 1 算"
              style={{ width: 66 }}
            />
            <span className="mono tiny" style={{ minWidth: 48, textAlign: 'right' }}>
              / {frames.length || FRAME_MAX}
            </span>
            <button className="btn primary tiny" disabled={aniBusy || gifFrames === 1} onClick={() => void sendAni(false)}>
              {aniBusy ? '上传中…' : '上传到动图页'}
            </button>
            <button className="btn ghost tiny" disabled={aniBusy || gifFrames === 1} onClick={() => void sendAni(true)}>
              {aniBusy ? '上传中…' : '设为开机动画'}
            </button>
          </div>
          <div className="tiny muted" style={{ lineHeight: 1.6 }}>
            帧间隔由固件固定为 120ms（厂商工具同样没有这个选项）；上传约 0.7 秒/帧。
            {gifFrames === 1 && (
              <span className="warn-text"> 这个 GIF 只有 1 帧，至少需要 2 帧才能上传（原厂工具同样限制）。</span>
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h3>页面与对时</h3>
            <span className="pill" title="小屏是多页面系统：主页带时钟，图片页最多 17 张">
              0–16 页
            </span>
          </div>
          <div className="field">
            <label>显示第几页（键盘上 Fn+键 也能翻）</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button
                className="btn ghost tiny"
                disabled={pageBusy}
                onClick={() => void switchPage((page + 16) % 17)}
              >
                ← 上一页
              </button>
              <button
                className="btn ghost tiny"
                disabled={pageBusy}
                onClick={() => void switchPage((page + 1) % 17)}
              >
                下一页 →
              </button>
            </div>
            <div className="row wrap" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {Array.from({ length: 17 }, (_, i) => (
                <button
                  key={i}
                  className={'btn tiny' + (page === i ? ' primary' : ' ghost')}
                  disabled={pageBusy}
                  onClick={() => void switchPage(i)}
                >
                  {i}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>时钟校准</label>
            <button className="btn ghost tiny" onClick={() => void syncClock()}>
              把电脑时间同步到键盘
            </button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>图片</h3>
            <button className="btn ghost tiny" onClick={() => void pick()}>
              选择图片…
            </button>
          </div>

          <div className="screen-preview-box">
            {preview ? (
              <img className="screen-preview-img" src={preview.dataUrl} alt="屏幕预览" />
            ) : (
              <div className="empty-hint">
                {imgPath ? '点「生成预览」查看实际下发效果' : '还没有选择图片'}
              </div>
            )}
          </div>

          {preview && (
            <div className="preview-stats">
              <span>
                屏幕尺寸 <b className="mono">{preview.width}×{preview.height}</b>
              </span>
              <span>
                像素 <b className="mono">{preview.pixelBytes} B</b>
              </span>
              <span>
                帧数 <b className="mono">{preview.chunkCount}</b>
              </span>
              {preview.frames > 1 && <span className="warn-text">GIF {preview.frames} 帧（只发第一帧）</span>}
            </div>
          )}

          <div className="field">
            <label>缩放方式</label>
            <div className="row wrap">
              {(
                [
                  ['contain', '居中留黑'],
                  ['cover', '填充裁切'],
                  ['stretch', '拉伸铺满'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={`chip ${fitMode === id ? 'active' : ''}`}
                  onClick={() => {
                    setFitMode(id)
                    if (imgPath) void previewImage()
                  }}
                >
                  {label}
                </button>
              ))}
              <button className="btn ghost tiny" onClick={() => void previewImage()} disabled={!imgPath}>
                生成预览
              </button>
            </div>
          </div>

          {preview?.hexPreview?.length ? (
            <details className="hexbox">
              <summary>实际下发的前两帧</summary>
              <pre>{preview.hexPreview.join('\n\n')}</pre>
            </details>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>协议</h3>
          </div>


          <button className="btn ghost tiny" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? '收起高级参数' : '展开高级参数'}
          </button>

          {showAdvanced && (
            <div className="adv">
              <div className="row wrap">
                <label className="inline">
                  宽
                  <input
                    className="input tiny mono"
                    type="number"
                    value={cfg.width}
                    onChange={(e) => setCfg({ ...cfg, width: Number(e.target.value) })}
                  />
                </label>
                <label className="inline">
                  高
                  <input
                    className="input tiny mono"
                    type="number"
                    value={cfg.height}
                    onChange={(e) => setCfg({ ...cfg, height: Number(e.target.value) })}
                  />
                </label>
                <label className="inline">
                  起始后等待 ms
                  <input
                    className="input tiny mono"
                    type="number"
                    min={0}
                    max={2000}
                    value={cfg.gapMs}
                    onChange={(e) => setCfg({ ...cfg, gapMs: Number(e.target.value) })}
                  />
                </label>
                <label className="inline">
                  数据帧间隔 ms
                  <input
                    className="input tiny mono"
                    type="number"
                    min={0}
                    max={50}
                    value={cfg.chunkDelayMs}
                    onChange={(e) => setCfg({ ...cfg, chunkDelayMs: Number(e.target.value) })}
                  />
                </label>
                <label className="inline">
                  字节序
                  <select
                    className="input tiny"
                    value={cfg.byteOrder}
                    onChange={(e) => setCfg({ ...cfg, byteOrder: e.target.value as 'le' | 'be' })}
                  >
                    <option value="be">RGB565 大端（实测）</option>
                    <option value="le">RGB565 小端</option>
                  </select>
                </label>
              </div>
              <div className="row">
                <button
                  className="btn ghost tiny"
                  onClick={() => {
                    resetScreenConfig()
                    setCfg({ ...DEFAULT_SCREEN_CONFIG })
                    toast.push('info', '已恢复实测默认参数')
                  }}
                >
                  重置屏幕参数
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {sending && (
        <div className="progress-wrap">
          <div className="progress">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="progress-text">
            {progress.sent}/{progress.total} 帧（{pct}%）
          </span>
        </div>
      )}

      <div className="action-bar simple">
        <span className="dirty-info">{imgPath ? imgPath.split('\\').pop() : '未选择图片'}</span>
      </div>
    </div>
  )
}