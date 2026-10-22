package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image/png"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"strings"

	"al80-studio/internal/device"
	"al80-studio/internal/hidwin"
	"al80-studio/internal/lcd"
	"al80-studio/internal/macro"
	"al80-studio/internal/screen"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App 暴露给前端的接口集合
type App struct {
	ctx context.Context
	mgr *device.Manager
}

func NewApp() *App { return &App{} }

// logf 把关键事件写到 %TEMP%\al80-studio.log，方便排查（不写注册表、不落配置文件）。
// 文件超过 512KB 自动重置，避免长期使用无限增长。
func logf(format string, args ...any) {
	path := filepath.Join(os.TempDir(), "al80-studio.log")
	if fi, err := os.Stat(path); err == nil && fi.Size() > 512*1024 {
		_ = os.Remove(path)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	lastKeySig := ""
	a.mgr = device.NewManager(func(event string, data any) {
		runtime.EventsEmit(ctx, event, data)
		if event == "key:watch" {
			if st, ok := data.(device.KeyWatchState); ok {
				// 现在每 16ms 推一帧（为了维持"按住不放"的高亮），
				// 日志只在按键集合真的变化时写，否则 60 行/秒会把日志文件撑爆
				sig := st.Error
				for _, p := range st.Pressed {
					sig += ";" + strconv.Itoa(p[0]) + "," + strconv.Itoa(p[1])
				}
				if sig != lastKeySig {
					lastKeySig = sig
					logf("keywatch active=%v pressed=%v rows=%04X", st.Active, st.Pressed, st.Rows)
				}
			}
		}
	})
	logf("startup version=%s", a.Version())
	// 屏幕链路自检（AL80_SCREENTEST=1）：走界面完全相同的代码路径，结果写日志
	if os.Getenv("AL80_SCREENTEST") != "" {
		go func() {
			time.Sleep(9 * time.Second)
			p := screen.Params{Width: 96, Height: 160, FitMode: "contain", ByteOrder: "be"}
			logf("screentest: 切页 begin")
			if err := a.ScreenCommand(p, "page", 1); err != nil {
				logf("screentest: 切页失败 %v", err)
			} else {
				logf("screentest: 切页成功")
			}
			time.Sleep(2 * time.Second)
			logf("screentest: 对时 begin")
			if err := a.ScreenCommand(p, "clock", 0); err != nil {
				logf("screentest: 对时失败 %v", err)
			} else {
				logf("screentest: 对时成功")
			}
			time.Sleep(2 * time.Second)
			logf("screentest: 动图 begin")
			// 自检用的示例动图路径由环境变量指定，避免把本机路径写进源码
			res, err := a.ScreenSendAnimation(os.Getenv("AL80_SCREENTEST_GIF"), p, 0, false)
			if err != nil {
				logf("screentest: 动图失败 %v", err)
			} else {
				logf("screentest: 动图成功 %d 帧 %dms", res.Frames, res.ElapsedMs)
			}
			time.Sleep(3 * time.Second)
			logf("screentest: 完成，看门狗是否还连 %v", a.mgr.Status().Connected)
		}()
	}
	// 对账用：把设备当前读到的第 0 层键码整排打出来（和 VIA 存的快照逐格比）
	if os.Getenv("AL80_SHOT") != "" {
		go func() {
			time.Sleep(6 * time.Second)
			km, err := a.ReadKeymap()
			if err != nil {
				logf("keymapdump err=%v", err)
				return
			}
			if raw, ok := km["layers"]; ok {
				logf("keymapdump %v", raw)
			} else {
				for k := range km {
					logf("keymapdump key=%s", k)
				}
			}
		}()
	}
	// 开发诊断：AL80_GEO=1 时把键盘图上每个键的实际坐标写进日志（核对间距用）
	if os.Getenv("AL80_GEO") != "" {
		go func() {
			time.Sleep(4 * time.Second)
			a.execJS(`(function(){
  try {
    const cv = document.querySelector('.kbm-host canvas');
    const host = document.querySelector('.kbm-host');
    const caps2 = document.querySelectorAll('.keycap').length;
    const hr = host ? host.getBoundingClientRect() : null;
    const info = {
      modelCanvas: cv ? { w: cv.width, h: cv.height } : null,
      host: hr ? { x: Math.round(hr.left), y: Math.round(hr.top), w: Math.round(hr.width), h: Math.round(hr.height) } : null,
      dpr: window.devicePixelRatio,
      flatCaps: caps2,
      modal: !!document.querySelector('.modal')
    };
    window.go.main.App.DebugLog('GEO ' + JSON.stringify(info));
    if (cv) {
      // 端到端：在模型中央模拟一次点击，看看是否弹出改键框
      const r = cv.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const opt = { clientX: cx, clientY: cy, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      cv.dispatchEvent(new PointerEvent('pointerdown', opt));
      cv.dispatchEvent(new PointerEvent('pointerup', opt));
      setTimeout(function(){
        const m = document.querySelector('.modal');
        window.go.main.App.DebugLog('GEO2 ' + JSON.stringify({
          modalOpen: !!m,
          modalText: m ? (m.textContent || '').replace(/\s+/g, ' ').slice(0, 70) : ''
        }));
        const close = document.querySelector('.modal .modal-close');
        if (close) close.click();
      }, 400);
    }
  } catch (e) {
    window.go.main.App.DebugLog('GEO err ' + e.message);
  }
})()`)
		}()
	}
	a.mgr.OnAutoConnect = func(who string) { logf("autoconnect from %s", who) }
	// 热插拔看门狗：掉线自动重连、插上自动识别（用户主动断开时不打扰）
	a.mgr.StartWatchdog(2 * time.Second)
	go func() {
		time.Sleep(300 * time.Millisecond)
		st, err := a.mgr.AutoConnect()
		if err != nil {
			logf("autoconnect failed: %v donglePresent=%v dongle=%q warnings=%v", err, st.DonglePresent, st.DongleName, st.Warnings)
			return
		}
		if st.Connected {
			logf("connected product=%q kind=%s via=%d layers=%d payload=%dB layout=%s encoderConfigurable=%v",
				st.Product, st.KindLabel, st.ProtocolVersion, st.LayerCount, st.PayloadLen, st.Layout, st.EncoderConfigurable)
			runtime.LogInfof(ctx, "已连接 %s (%s)", st.Product, st.KindLabel)
		}
		if km, err := a.mgr.ReadKeymap(); err != nil {
			logf("readkeymap failed: %v", err)
		} else {
			layers := km["layers"].([][]uint16)
			logf("readkeymap ok layers=%d keys=%d first=%04X", len(layers), len(layers[0]), layers[0][0])
		}
		if li, err := a.mgr.ReadLighting(); err != nil {
			logf("readlighting failed: %v", err)
		} else {
			logf("readlighting ok %v", li)
		}
		time.Sleep(4 * time.Second)
		a.DebugHooks() // 只挂错误监听：任何前端异常都会写进 %TEMP%\al80-studio.log
	}()
}

func (a *App) shutdown(ctx context.Context) {
	logf("shutdown")
	if a.mgr != nil {
		a.mgr.Disconnect()
		a.mgr.Stop()
	}
}

// ---------- 开发期界面自检 ----------

func (a *App) execJS(js string) {
	if a.ctx == nil {
		return
	}
	runtime.WindowExecJS(a.ctx, js)
}

func (a *App) dumpContent(tag string) {
	a.execJS(`(function(tag){
  try {
    const el = document.querySelector('.content') || document.body;
    const t = (el.innerText || '').replace(/\s+/g, ' ').slice(0, 800);
    window.go.main.App.DebugLog(tag + ' :: ' + t);
  } catch (e) { window.go.main.App.DebugLog(tag + ' :: ERR ' + e.message); }
})('` + tag + `')`)
}

// DebugHooks 把前端未捕获异常转发到日志
func (a *App) DebugHooks() {
	a.execJS(`(function(){
  if (window.__al80Hooked) return;
  window.__al80Hooked = true;
  const send = (k, m) => { try { window.go.main.App.DebugLog(k + ': ' + m); } catch (e) {} };
  window.addEventListener('error', (e) => send('JSERROR', (e.message || '') + ' @' + (e.lineno || '')));
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason; send('JSREJECT', (r && (r.message || r)) + ''); });
})()`)
}

// DebugSmoke 端到端冒烟：真实点击 → 真实绑定 → 真实下发，全程只做无副作用操作。
func (a *App) DebugSmoke() {
	if a.ctx == nil {
		return
	}
	a.DebugHooks()
	time.Sleep(400 * time.Millisecond)

	// 1) 按键页：打开键值选择器（只读，不写入）
	logf("smoke1: 打开键值选择器")
	a.execJS(`(function(){
  try {
    const caps = document.querySelectorAll('.keycap');
    if (!caps.length) { window.go.main.App.DebugLog('smoke: 没有 keycap'); return; }
    caps[1].click();
    setTimeout(function(){
      const m = document.querySelector('.modal');
      const t = m ? (m.innerText||'').replace(/\s+/g,' ').slice(0,300) : 'NO MODAL';
      window.go.main.App.DebugLog('键值选择器 :: ' + t);
      const close = m ? m.querySelector('.modal-head .btn') : null;
      if (close) close.click();
    }, 400);
  } catch (e) { window.go.main.App.DebugLog('smoke1 err ' + e.message); }
})()`)
	time.Sleep(1200 * time.Millisecond)

	// 2) 灯光页：点「应用到键盘」，用当前值下发（等于不改任何东西），看 toast
	logf("smoke2: 灯光应用到键盘")
	a.execJS(`(function(){
  try {
    document.querySelectorAll('nav.tabs.main button')[1].click();
    setTimeout(function(){
      const btns = Array.prototype.slice.call(document.querySelectorAll('.page-foot button, .bottom-bar button, button'));
      const apply = btns.filter(function(b){ return (b.textContent||'').indexOf('应用到键盘') >= 0; })[0];
      if (!apply) { window.go.main.App.DebugLog('smoke2: 找不到应用到键盘'); return; }
      apply.click();
      setTimeout(function(){
        const toasts = Array.prototype.slice.call(document.querySelectorAll('.toast')).map(function(t){ return (t.innerText||'').replace(/\s+/g,' '); });
        window.go.main.App.DebugLog('灯光下发 toast :: ' + (toasts.length ? toasts.join(' | ') : '无 toast'));
      }, 1500);
    }, 500);
  } catch (e) { window.go.main.App.DebugLog('smoke2 err ' + e.message); }
})()`)
	time.Sleep(3200 * time.Millisecond)

	// 3) 断开 → 看自动重连
	st := a.mgr.Status()
	logf("smoke3: 断开前 connected=%v", st.Connected)
	a.mgr.Disconnect()
	time.Sleep(300 * time.Millisecond)
	st = a.mgr.Status()
	logf("smoke3: 断开后 connected=%v", st.Connected)
	time.Sleep(6 * time.Second)
	st = a.mgr.Status()
	logf("smoke3: 等待 6 秒后 connected=%v product=%q kind=%q err=%q", st.Connected, st.Product, st.KindLabel, st.LastError)

	// 4) 回到按键页
	a.execJS(`try{document.querySelectorAll('nav.tabs.main button')[0].click()}catch(e){}`)
}

// DebugLayout 逐页检查是否有横向溢出（新控件撑破排版）
func (a *App) DebugLayout() {
	if a.ctx == nil {
		return
	}
	a.DebugHooks()
	time.Sleep(600 * time.Millisecond)
	a.execJS(`(function(){
  const report = [];
  function check(tag) {
    const sels = ['.page', '.layer-switch', '.subtabs', '.macro-area', '.two-col', '.action-bar'];
    sels.forEach(function(sel){
      document.querySelectorAll(sel).forEach(function(el, i){
        const over = el.scrollWidth - el.clientWidth;
        if (over > 2) { report.push(tag + ' ' + sel + '#' + i + ' 溢出 ' + over + 'px'); }
      });
    });
    const b = document.body;
    report.push(tag + ' 页面宽 ' + b.clientWidth + ' 内容宽 ' + b.scrollWidth);
  }
  const tabs = document.querySelectorAll('nav.tabs.main button');
  const subs = function(){ return Array.prototype.slice.call(document.querySelectorAll('.subtab')); };
  check('按键页');
  if (subs()[1]) { subs()[1].click(); }
  setTimeout(function(){
    check('宏面板');
    if (subs()[0]) subs()[0].click();
    if (tabs[1]) tabs[1].click();
    setTimeout(function(){
      check('灯光页');
      if (tabs[2]) tabs[2].click();
      setTimeout(function(){
        check('屏幕页');
        if (tabs[0]) tabs[0].click();
        setTimeout(function(){
          window.go.main.App.DebugLog('布局检查 :: ' + report.join(' | '));
        }, 500);
      }, 800);
    }, 800);
  }, 900);
})()`)
	time.Sleep(4500 * time.Millisecond)
}
// DebugCheckSmoke 打开齿轮菜单 -> 能力自检，确认弹窗渲染出结果
func (a *App) DebugCheckSmoke() {
	if a.ctx == nil {
		return
	}
	a.DebugHooks()
	time.Sleep(900 * time.Millisecond)
	logf("check-smoke: 打开齿轮菜单 -> 能力自检")
	a.execJS(`(function(){
  try {
    const gear = document.querySelector('.btn.icon[title="设置"]');
    if (!gear) { window.go.main.App.DebugLog('check: 找不到齿轮按钮'); return; }
    gear.click();
    setTimeout(function(){
      const item = Array.prototype.slice.call(document.querySelectorAll('.dropdown button'))
        .filter(function(b){ return (b.textContent||'').indexOf('能力自检') >= 0; })[0];
      if (!item) { window.go.main.App.DebugLog('check: 菜单里没有能力自检'); return; }
      item.click();
      setTimeout(function(){
        const rows = Array.prototype.slice.call(document.querySelectorAll('.check-row'))
          .map(function(r){ return (r.className.indexOf('ok') >= 0 ? '[OK] ' : '[FAIL] ')
            + (r.querySelector('.check-name')||{}).textContent + ' :: ' + (r.querySelector('.check-detail')||{}).textContent; });
        const sum = document.querySelector('.check-summary');
        window.go.main.App.DebugLog('自检弹窗 :: ' + (sum ? (sum.innerText||'').replace(/\s+/g,' ') : '无汇总') + ' || ' + rows.join(' | '));
      }, 2500);
    }, 400);
  } catch (e) { window.go.main.App.DebugLog('check err ' + e.message); }
})()`)
	time.Sleep(5000 * time.Millisecond)
}
// DebugLayerSmoke 验证「整层复制/粘贴」与「导出快照读取」两条链路（只动前端草稿，不写键盘）
func (a *App) DebugLayerSmoke() {
	if a.ctx == nil {
		return
	}
	a.DebugHooks()
	time.Sleep(600 * time.Millisecond)

	logf("layer-smoke: 复制第1层 -> 粘贴到第2层")
	a.execJS(`(function(){
  try {
    const btns = Array.prototype.slice.call(document.querySelectorAll('button'));
    const copy = btns.filter(function(b){ return (b.textContent||'').trim() === '复制本层'; })[0];
    if (!copy) { window.go.main.App.DebugLog('layer: 找不到复制本层按钮'); return; }
    copy.click();
    setTimeout(function(){
      const chips = Array.prototype.slice.call(document.querySelectorAll('.layer-switch .chip'));
      if (chips[1]) chips[1].click();
      setTimeout(function(){
        const paste = Array.prototype.slice.call(document.querySelectorAll('button'))
          .filter(function(b){ return (b.textContent||'').trim() === '粘贴到本层'; })[0];
        if (!paste) { window.go.main.App.DebugLog('layer: 找不到粘贴按钮'); return; }
        paste.click();
        setTimeout(function(){
          const dirty = document.querySelector('.dirty-info');
          const caps = Array.prototype.slice.call(document.querySelectorAll('.keycap')).slice(0, 6)
            .map(function(c){ return c.getAttribute('title'); });
          window.go.main.App.DebugLog('粘贴后 :: 待写入=' + (dirty ? (dirty.innerText||'').trim() : '?') + ' | 前6键=' + caps.join(' / '));
          // 恢复：放弃草稿（不写键盘）
          const reload = Array.prototype.slice.call(document.querySelectorAll('button'))
            .filter(function(b){ return (b.textContent||'').trim() === '重新读取'; })[0];
          if (reload) reload.click();
          setTimeout(function(){
            const d2 = document.querySelector('.dirty-info');
            window.go.main.App.DebugLog('重新读取后 :: ' + (d2 ? (d2.innerText||'').trim() : '?'));
            const chips2 = Array.prototype.slice.call(document.querySelectorAll('.layer-switch .chip'));
            if (chips2[0]) chips2[0].click();
          }, 1200);
        }, 500);
      }, 400);
    }, 400);
  } catch (e) { window.go.main.App.DebugLog('layer err ' + e.message); }
})()`)
	time.Sleep(4500 * time.Millisecond)

	logf("layer-smoke: 组装导出快照（不打开对话框）")
	a.execJS(`(function(){
  Promise.all([
    window.go.main.App.ReadKeymap(),
    window.go.main.App.ReadMacros(),
    window.go.main.App.ReadLighting()
  ]).then(function(r){
    const km = r[0], mac = r[1], light = r[2];
    const filled = (mac.slots||[]).filter(function(s){ return s.bytes > 0; }).length;
    window.go.main.App.DebugLog('导出快照 :: 键位 ' + km.layers.length + '层x' + km.layers[0].length + '格 首键=0x' + km.layers[0][0].toString(16).toUpperCase()
      + ' | 宏 ' + filled + '/' + mac.count + ' 条有内容 | 灯光 effect=' + light.effect + ' brightness=' + light.brightness);
    window.dispatchEvent(new CustomEvent('al80:config-applied'));
  }).catch(function(e){ window.go.main.App.DebugLog('快照失败 ' + (e && e.message ? e.message : e)); });
})()`)
	time.Sleep(2500 * time.Millisecond)
}
// DebugMacroSmoke 验证宏面板渲染 + 宏写盘（走前端绑定）
func (a *App) DebugMacroSmoke() {
	if a.ctx == nil {
		return
	}
	a.DebugHooks()
	time.Sleep(500 * time.Millisecond)

	logf("macro-smoke: 切到宏面板")
	a.execJS(`(function(){
  try {
    const subs = Array.prototype.slice.call(document.querySelectorAll('.subtab'));
    const macro = subs.filter(function(b){ return (b.textContent||'').indexOf('宏') >= 0; })[0];
    if (!macro) { window.go.main.App.DebugLog('macro: 找不到宏子标签'); return; }
    macro.click();
    setTimeout(function(){
      const el = document.querySelector('.macro-area');
      window.go.main.App.DebugLog('宏面板 :: ' + (el ? (el.innerText||'').replace(/\s+/g,' ').slice(0,420) : 'NO .macro-area'));
    }, 900);
  } catch (e) { window.go.main.App.DebugLog('macro err ' + e.message); }
})()`)
	time.Sleep(2200 * time.Millisecond)

	logf("macro-smoke: 通过绑定写宏")
	a.execJS(`(function(){
  window.go.main.App.SaveMacros(['Hi{enter}','{ctrl+c}'])
    .then(function(){ return window.go.main.App.ReadMacros(); })
    .then(function(info){
      const filled = (info.slots||[]).filter(function(s){ return s.bytes > 0; })
        .map(function(s){ return 'M'+s.index+'='+JSON.stringify(s.text)+'('+s.bytes+'B)'; });
      window.go.main.App.DebugLog('宏写入结果 :: 已用=' + info.usedBytes + ' ' + filled.join(' '));
      return window.go.main.App.ClearMacros();
    })
    .then(function(){ return window.go.main.App.ReadMacros(); })
    .then(function(info){ window.go.main.App.DebugLog('清空后已用=' + info.usedBytes); })
    .catch(function(e){ window.go.main.App.DebugLog('宏流程失败 ' + (e && e.message ? e.message : e)); });
})()`)
	time.Sleep(3500 * time.Millisecond)

	// 回到键位视图
	a.execJS(`try{var s=Array.prototype.slice.call(document.querySelectorAll('.subtab'));if(s[0])s[0].click()}catch(e){}`)
}
// DebugTour 依次切三个页面并打开诊断面板，把各页真实渲染文本写进日志，最后回到按键页。
func (a *App) DebugTour() {
	if a.ctx == nil {
		return
	}
	a.DebugHooks()
	time.Sleep(300 * time.Millisecond)

	logf("tour: tab2")
	a.execJS(`try{document.querySelectorAll('nav.tabs.main button')[1].click();window.go.main.App.DebugLog('tour: clicked tab2')}catch(e){window.go.main.App.DebugLog('tour err '+e.message)}`)
	time.Sleep(800 * time.Millisecond)
	a.dumpContent("灯光页")

	logf("tour: tab3")
	a.execJS(`try{document.querySelectorAll('nav.tabs.main button')[2].click();window.go.main.App.DebugLog('tour: clicked tab3')}catch(e){window.go.main.App.DebugLog('tour err '+e.message)}`)
	time.Sleep(800 * time.Millisecond)
	a.dumpContent("屏幕页")

	logf("tour: diag")
	a.execJS(`(function(){
  try {
    const gear = document.querySelector('.topbar-actions .menu-wrap button');
    if (!gear) { window.go.main.App.DebugLog('tour: no gear'); return; }
    gear.click();
    setTimeout(function(){
      const items = Array.prototype.slice.call(document.querySelectorAll('.dropdown button'));
      const diag = items.filter(function(b){ return (b.textContent||'').indexOf('诊断') >= 0; })[0];
      if (!diag) { window.go.main.App.DebugLog('tour: no diag item, items=' + items.map(function(b){return b.textContent}).join('/')); return; }
      diag.click();
      setTimeout(function(){
        const m = document.querySelector('.modal');
        window.go.main.App.DebugLog('诊断面板 :: ' + (m ? (m.innerText||'').replace(/\s+/g,' ').slice(0,900) : 'NO MODAL'));
      }, 700);
    }, 300);
  } catch (e) { window.go.main.App.DebugLog('tour diag err ' + e.message); }
})()`)
	time.Sleep(1800 * time.Millisecond)

	logf("tour: back")
	a.execJS(`(function(){
  try {
    const close = document.querySelector('.modal .modal-close') || document.querySelector('.modal button');
    if (close) close.click();
    setTimeout(function(){ document.querySelectorAll('nav.tabs.main button')[0].click(); }, 250);
  } catch (e) {}
})()`)
}

func (a *App) Version() string { return "0.1.0" }

// ---------- 连接 ----------

func (a *App) Status() device.Status {
	if a.mgr == nil {
		return device.Status{}
	}
	return a.mgr.Status()
}

func (a *App) AutoConnect() (device.Status, error) { return a.mgr.AutoConnect() }

func (a *App) Connect(path string) (device.Status, error) { return a.mgr.Connect(path) }

func (a *App) Disconnect() device.Status { return a.mgr.Disconnect() }

func (a *App) ScanDevices() ([]hidwin.Info, error) { return a.mgr.Scan() }

// DebugE2E 交付自检：从引导开始，走完「改键→应用→读回→还原」＋灯光＋宏＋自检
func (a *App) DebugE2E() {
	if a.ctx == nil {
		return
	}
	a.DebugHooks()
	time.Sleep(2000 * time.Millisecond)

	logf("e2e: 第 1 步 新手引导")
	a.execJS(`(function(){
  function log(m){ window.go.main.App.DebugLog(m); }
  const g = document.querySelector('.onboard');
  log('e2e1 引导可见=' + !!g + ' 标记=' + localStorage.getItem('al80.onboarded.v2'));
  if (g) {
    const done = Array.prototype.slice.call(g.querySelectorAll('button')).filter(function(b){ return (b.textContent||'').trim() === '开始使用'; })[0] ||
                 Array.prototype.slice.call(g.querySelectorAll('button')).filter(function(b){ return (b.textContent||'').trim() === '下一步'; })[0];
    if (done) done.click();
    setTimeout(function(){
      const d2 = Array.prototype.slice.call(document.querySelectorAll('.onboard button')).filter(function(b){ return (b.textContent||'').trim() === '开始使用'; })[0];
      if (d2) d2.click();
    }, 300);
    setTimeout(function(){ log('e2e1 引导关闭后标记=' + localStorage.getItem('al80.onboarded.v2')); }, 900);
  }
})()`)
	time.Sleep(2600 * time.Millisecond)

	logf("e2e: 第 2 步 切到第 4 层，把 [0,0] 改成 Esc 并应用，然后还原")
	a.execJS(`(function(){
  function log(m){ window.go.main.App.DebugLog(m); }
  function btns(root, txt){ return Array.prototype.slice.call((root||document).querySelectorAll('button')).filter(function(b){ return (b.textContent||'').trim() === txt; })[0]; }
  const chips = document.querySelectorAll('.layer-switch .chip');
  if (!chips[3]) { log('e2e2 找不到第 4 层'); return; }
  chips[3].click();
  setTimeout(function(){
    const cap = Array.prototype.slice.call(document.querySelectorAll('.keycap')).filter(function(c){ return (c.getAttribute('title')||'').indexOf('[0,0]') === 0; })[0];
    if (!cap) { log('e2e2 找不到 [0,0] 键帽'); return; }
    log('e2e2 改前 [0,0] = ' + cap.getAttribute('title'));
    cap.click();
    setTimeout(function(){
      const tab = btns(document.querySelector('.modal .tabs'), '自定义');
      if (!tab) { log('e2e2 找不到自定义标签'); return; }
      tab.click();
      setTimeout(function(){
        const inp = document.querySelector('.modal input.input.mono');
        if (!inp) { log('e2e2 找不到输入框'); return; }
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, '0x0029');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        const use = btns(document.querySelector('.modal'), '使用');
        if (!use) { log('e2e2 找不到使用按钮'); return; }
        use.click();
        setTimeout(function(){
          const dirty = document.querySelector('.dirty-info');
          log('e2e2 选完后 = ' + (dirty ? dirty.innerText.trim() : '?'));
          const apply = btns(document, '应用到键盘');
          if (!apply) { log('e2e2 找不到应用按钮'); return; }
          apply.click();
          setTimeout(function(){
            window.go.main.App.ReadKeymap().then(function(km){
              log('e2e2 应用到键盘后 第4层[0,0] = 0x' + km.layers[3][0].toString(16).toUpperCase().padStart(4,'0'));
              // 还原成 0x0000
              const cap2 = Array.prototype.slice.call(document.querySelectorAll('.keycap')).filter(function(c){ return (c.getAttribute('title')||'').indexOf('[0,0]') === 0; })[0];
              cap2.click();
              setTimeout(function(){
                const tab2 = btns(document.querySelector('.modal .tabs'), '自定义');
                tab2.click();
                setTimeout(function(){
                  const inp2 = document.querySelector('.modal input.input.mono');
                  const setter2 = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                  setter2.call(inp2, '0x0000');
                  inp2.dispatchEvent(new Event('input', { bubbles: true }));
                  setTimeout(function(){
                    btns(document.querySelector('.modal'), '使用').click();
                    setTimeout(function(){
                      btns(document, '应用到键盘').click();
                      setTimeout(function(){
                        window.go.main.App.ReadKeymap().then(function(km2){
                          log('e2e2 还原后 第4层[0,0] = 0x' + km2.layers[3][0].toString(16).toUpperCase().padStart(4,'0'));
                          location.reload();
                        });
                      }, 2500);
                    }, 500);
                  }, 300);
                }, 400);
              }, 400);
            });
          }, 2500);
        }, 500);
      }, 400);
    }, 500);
  }, 600);
})()`)
	time.Sleep(16000 * time.Millisecond)

	logf("e2e: 第 3 步 宏写入/读回/清空 + 能力自检 + 灯光读取")
	a.execJS(`(function(){
  function log(m){ window.go.main.App.DebugLog(m); }
  const api = window.go.main.App;
  api.SaveMacros(['E2E{enter}', '{ctrl+c}'])
    .then(function(){ return api.ReadMacros(); })
    .then(function(m){
      log('e2e3 宏写入=' + (m.slots||[]).filter(function(s){ return s.bytes > 0; })
        .map(function(s){ return 'M' + s.index + '=' + JSON.stringify(s.text) + '(' + s.bytes + 'B)'; }).join(' '));
      return api.ClearMacros();
    })
    .then(function(){ return api.ReadMacros(); })
    .then(function(m){ log('e2e3 清空后已用=' + m.usedBytes); })
    .then(function(){ return api.SelfCheck(); })
    .then(function(sc){ log('e2e3 自检 可用=' + sc.okCount + ' 不可用=' + sc.failCount); })
    .then(function(){ return api.ReadLighting(); })
    .then(function(li){ log('e2e3 灯光读取=' + JSON.stringify(li)); })
    .then(function(){ return api.ReadKeymap(); })
    .then(function(km){ log('e2e3 键位读取 层数=' + km.layers.length + ' 首键=0x' + km.layers[0][0].toString(16).toUpperCase()); })
    .catch(function(e){ log('e2e3 失败: ' + (e && e.message ? e.message : e)); });
})()`)
	time.Sleep(9000 * time.Millisecond)

	logf("e2e: 第 4 步 三页切换")
	a.execJS(`(function(){
  function log(m){ window.go.main.App.DebugLog(m); }
  const tabs = document.querySelectorAll('nav.tabs.main button');
  if (!tabs[1]) { log('e2e4 找不到页签'); return; }
  const names = [];
  function visit(i){
    if (!tabs[i]) { log('e2e4 三页都渲染过: ' + names.join(' / ')); return; }
    tabs[i].click();
    setTimeout(function(){
      const h = document.querySelector('.page-head h2');
      names.push((h ? h.textContent : '?') + ':' + document.querySelectorAll('.page .btn, .page button').length + '个按钮');
      visit(i + 1);
    }, 900);
  }
  visit(0);
})()`)
	time.Sleep(4500 * time.Millisecond)
}
// DebugGuideCheckReadonly 只看一眼引导是否出现，不点任何按钮（不写标记）
func (a *App) DebugGuideCheckReadonly() {
	if a.ctx == nil {
		return
	}
	a.DebugHooks()
	time.Sleep(2000 * time.Millisecond)
	a.execJS(`(function(){
  const el = document.querySelector('.onboard');
  const steps = el ? el.querySelectorAll('.onboard-step').length : 0;
  window.go.main.App.DebugLog('只读检查 :: 引导可见=' + !!el + ' 步骤区=' + steps
    + ' 标记=' + localStorage.getItem('al80.onboarded.v2')
    + ' 连接提示=' + ((document.querySelector('.onboard-status')||{}).innerText || '-'));
})()`)
	time.Sleep(2500 * time.Millisecond)
}
// DebugGuideCheck 检查新手引导：首次是否弹出、关掉后是否记住
func (a *App) DebugGuideCheck() {
	if a.ctx == nil {
		return
	}
	a.DebugHooks()
	time.Sleep(1800 * time.Millisecond)
	a.execJS(`(function(){
  function log(m){ window.go.main.App.DebugLog(m); }
  const el = document.querySelector('.onboard');
  log('引导可见=' + !!el + ' | 记住标记=' + localStorage.getItem('al80.onboarded'));
  if (!el) {
    // 已看过：验证齿轮菜单能重新打开
    const gear = document.querySelector('.btn.icon[title="设置"]');
    if (!gear) { log('找不到齿轮'); return; }
    gear.click();
    setTimeout(function(){
      const item = Array.prototype.slice.call(document.querySelectorAll('.dropdown button'))
        .filter(function(b){ return (b.textContent||'').indexOf('新手引导') >= 0; })[0];
      if (!item) { log('菜单里没有新手引导'); return; }
      item.click();
      setTimeout(function(){
        const re = document.querySelector('.onboard');
        log('从齿轮重新打开引导 :: 可见=' + !!re + (re ? ' 标题=' + ((re.querySelector('.modal-title')||{}).textContent||'') : ''));
      }, 500);
    }, 400);
    return;
  }
  if (el) {
    log('引导内容 :: ' + (el.innerText||'').replace(/\s+/g,' ').slice(0, 300));
    const next = Array.prototype.slice.call(el.querySelectorAll('button')).filter(function(b){ return (b.textContent||'').trim() === '下一步'; })[0];
    if (next) { next.click(); next.click(); next.click(); }
    setTimeout(function(){
      const done = Array.prototype.slice.call(document.querySelectorAll('.onboard button')).filter(function(b){ return (b.textContent||'').trim() === '开始使用'; })[0];
      if (done) done.click();
      setTimeout(function(){
        log('关闭后 :: 还可见=' + !!document.querySelector('.onboard') + ' 记住标记=' + localStorage.getItem('al80.onboarded'));
      }, 400);
    }, 400);
  }
})()`)
	time.Sleep(4200 * time.Millisecond)
}
// DebugDiscCheck 检查 Disconnect 返回给前端的字段
func (a *App) DebugDiscCheck() {
	if a.ctx == nil {
		return
	}
	a.DebugHooks()
	time.Sleep(1500 * time.Millisecond)
	a.execJS(`(function(){
  function log(m){ window.go.main.App.DebugLog(m); }
  window.go.main.App.Disconnect().then(function(st){
    log('Disconnect 返回字段: ' + JSON.stringify(st));
    return window.go.main.App.Status();
  }).then(function(st2){
    log('Status 字段: ' + JSON.stringify({connected: st2.connected, userDisconnected: st2.userDisconnected}));
    setTimeout(function(){
      const el = document.querySelector('.device-name');
      log('状态栏文本: ' + (el ? (el.innerText||'').trim() : '?'));
    }, 600);
  }).catch(function(e){ log('失败 ' + (e && e.message ? e.message : e)); });
})()`)
	time.Sleep(4000 * time.Millisecond)
}
// DebugHotplugSmoke 验证三条路径：手动断开要「粘住」、手动重连、模拟拔线后自动恢复
func (a *App) DebugHotplugSmoke() {
	if a.ctx == nil {
		return
	}
	a.DebugHooks()
	time.Sleep(1200 * time.Millisecond)

	logf("hotplug-smoke: 开始（手动断开 / 手动重连 / 模拟拔线）")
	a.execJS(`(function(){
  function log(m){ window.go.main.App.DebugLog(m); }
  function bar(){ const el = document.querySelector('.device-name') || document.querySelector('.status-bar'); return el ? (el.innerText||'').replace(/\s+/g,' ').trim() : '?'; }
  function btn(txt){ return Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){ return (b.textContent||'').trim() === txt; })[0]; }
  try {
    if (window.runtime && window.runtime.EventsOn) {
      window.runtime.EventsOn('device:changed', function(st){
        log('EVT device:changed connected=' + st.connected + ' userDisconnected=' + st.userDisconnected + ' err=' + (st.lastError||'-'));
      });
    }
  } catch (e) {}

  const off = btn('断开');
  if (!off) { log('hotplug: 找不到断开按钮'); return; }
  off.click();
  log('hotplug: 已点断开，等 8 秒看会不会自动连回来');

  setTimeout(function(){
    log('hotplug: 8 秒后状态栏 = "' + bar() + '"（期望：已手动断开）');
    const on = btn('连接设备') || btn('重新连接');
    if (!on) { log('hotplug: 找不到连接按钮'); return; }
    on.click();
    setTimeout(function(){
      log('hotplug: 手动重连后 = "' + bar() + '"');
      window.go.main.App.DebugSimulateUnplug().then(function(r){
        log('hotplug: ' + r + '，等 8 秒看自动恢复');
      });
      setTimeout(function(){
        log('hotplug: 拔线模拟 8 秒后 = "' + bar() + '"（期望：AL80 Keyboard）');
        window.go.main.App.Status().then(function(st){
          log('hotplug: 最终 Status connected=' + st.connected + ' product=' + st.product + ' userDisconnected=' + st.userDisconnected);
        });
      }, 8000);
    }, 3000);
  }, 8000);
})()`)
	time.Sleep(22000 * time.Millisecond)
}
// DebugSimulateUnplug 仅测试用：模拟「线被拔掉」（关掉句柄但不清理状态），
// 用来验证看门狗能否发现掉线并自动重连。
func (a *App) DebugSimulateUnplug() string {
	logf("test: 模拟拔掉键盘")
	a.mgr.ForceDropForTest()
	return "已模拟拔线"
}
// SelfCheck 逐项验证本机可用能力（只读，或把原值写回），返回结构化结果 + 文本报告
func (a *App) SelfCheck() device.SelfCheck { return a.mgr.SelfCheck() }

// SaveReport 把自检报告存成文件
func (a *App) SaveReport(content string) (string, error) {
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "保存 AL80 自检报告",
		DefaultFilename: "al80-selfcheck.txt",
		Filters:         []runtime.FileFilter{{DisplayName: "文本", Pattern: "*.txt"}},
	})
	if err != nil || path == "" {
		return "", err
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", err
	}
	return path, nil
}
func (a *App) Diagnose() (device.DiagResult, error) { return a.mgr.Diagnose() }

// ---------- 实时按键监测 ----------

// StartKeyWatch 开始轮询按键状态（按键页打开时启用），按下/松开通过 key:watch 事件推送。
func (a *App) StartKeyWatch() error {
	if a.mgr == nil {
		return fmt.Errorf("尚未初始化")
	}
	err := a.mgr.StartKeyWatch(16 * time.Millisecond) // ≈60Hz，和 VIA 矩阵测试同频，打字反馈不拖
	if err != nil {
		logf("startkeywatch failed: %v", err)
	} else {
		logf("startkeywatch ok")
	}
	return err
}

func (a *App) StopKeyWatch() {
	logf("stopkeywatch")
	if a.mgr != nil {
		a.mgr.StopKeyWatch()
	}
}

// ---------- 开发期自检（不影响正常使用） ----------

// DebugLog 接收前端 JS 传来的诊断文本并写进日志
func (a *App) DebugLog(msg string) {
	logf("js: %s", msg)
}

// WantShot 返回是否需要在渲染稳定后截一张 WebGL 画面（开发自检用，靠 AL80_SHOT 环境变量开启）
func (a *App) WantShot() bool { return os.Getenv("AL80_SHOT") != "" }

// SaveShot 接收前端传来的 PNG base64，落盘到临时目录，方便开发者肉眼核对画面
func (a *App) SaveShot(b64 string) string {
	if i := strings.Index(b64, ","); i >= 0 {
		b64 = b64[i+1:]
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		logf("SaveShot 解码失败: %v", err)
		return ""
	}
	out := filepath.Join(os.TempDir(), "al80-shot.png")
	if err := os.WriteFile(out, raw, 0o644); err != nil {
		logf("SaveShot 写入失败: %v", err)
		return ""
	}
	logf("SaveShot %s %d 字节", out, len(raw))
	return out
}
// SaveCap 接收前端导出的键帽画布 PNG，落盘到临时目录
func (a *App) SaveCap(b64 string) string {
	if i := strings.Index(b64, ","); i >= 0 {
		b64 = b64[i+1:]
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return ""
	}
	out := filepath.Join(os.TempDir(), "al80-cap.png")
	_ = os.WriteFile(out, raw, 0o644)
	logf("SaveCap %s %d 字节", out, len(raw))
	return out
}
// DebugProbe 让前端把一段自检 JS 跑一遍并把结果回传（用于确认界面实际渲染结果）
func (a *App) DebugProbe() {
	if a.ctx == nil {
		return
	}
	runtime.WindowExecJS(a.ctx, `(function(){
  const caps = Array.from(document.querySelectorAll('.keycap'));
  const labelOf = (c) => { const e = c.querySelector('.keycap-label'); return e ? (e.textContent || '') : null; };
  const empties = caps.filter(c => { const t = labelOf(c); return t === null || !t.trim(); }).length;
  const sample = caps.slice(0, 6).map(labelOf);
  const all = caps.map(labelOf).join('|');
  const first = caps[0];
  const le = first ? first.querySelector('.keycap-label') : null;
  const cs = le ? getComputedStyle(le) : null;
  const info = {
    caps: caps.length,
    empties: empties,
    sample: sample,
    all: all,
    labelFont: cs ? cs.fontSize : null,
    labelColor: cs ? cs.color : null,
    labelDisplay: cs ? cs.display : null,
    capSize: first ? Math.round(first.getBoundingClientRect().width) + 'x' + Math.round(first.getBoundingClientRect().height) : null,
    watchBar: !!document.querySelector('.keywatch-bar'),
    knobCard: !!document.querySelector('.knob-card'),
    page: (document.querySelector('.page h2') || {}).textContent || null,
    navTexts: Array.from(document.querySelectorAll('.topbar nav button, .nav button, nav button')).map(b => b.textContent.trim())
  };
  if (window.go && window.go.main && window.go.main.App && window.go.main.App.DebugLog) {
    window.go.main.App.DebugLog(JSON.stringify(info));
  }
})()`)
}

// ---------- 按键 ----------

type KeyChange struct {
	Layer   int    `json:"layer"`
	Row     int    `json:"row"`
	Col     int    `json:"col"`
	Keycode uint16 `json:"keycode"`
}

// ---------- 宏 ----------

// ReadMacros 返回宏区信息与每个宏的可读文本
func (a *App) ReadMacros() (device.MacroInfo, error) { return a.mgr.ReadMacros() }

// SaveMacros 把文本编码后写进键盘（每条最多约 460 字节操作码）
func (a *App) SaveMacros(texts []string) error { return a.mgr.WriteMacros(texts) }

// ClearMacros 清空全部宏（对应固件 id_macro_reset）
func (a *App) ClearMacros() error { return a.mgr.ClearMacros() }

// PreviewMacro 只做编码，不写设备：把文本编成字节并算长度，方便前端即时提示
func (a *App) PreviewMacro(text string) (map[string]any, error) {
	enc, err := macro.Encode(text)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}, nil
	}
	hex := make([]string, 0, len(enc))
	for _, b := range enc {
		hex = append(hex, fmt.Sprintf("%02X", b))
	}
	return map[string]any{"ok": true, "bytes": len(enc), "hex": strings.Join(hex, " ")}, nil
}
func (a *App) ReadKeymap() (map[string]any, error) { return a.mgr.ReadKeymap() }

func (a *App) SetKeycode(layer, row, col int, keycode uint16) error {
	return a.mgr.SetKeycode(layer, row, col, keycode)
}

// SetEncoderKey 写入旋钮旋转键码（clockwise 区分顺/逆时针）。
func (a *App) SetEncoderKey(layer int, clockwise bool, keycode uint16) error {
	return a.mgr.SetEncoderKey(layer, clockwise, keycode)
}

// ApplyKeymap 批量写入按键改动，返回成功条数。
func (a *App) ApplyKeymap(changes []KeyChange) (int, error) {
	applied := 0
	var firstErr error
	for _, ch := range changes {
		if err := a.mgr.SetKeycode(ch.Layer, ch.Row, ch.Col, ch.Keycode); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("[%d,%d] 层%d: %w", ch.Row, ch.Col, ch.Layer, err)
			}
			continue
		}
		applied++
	}
	return applied, firstErr
}

// ---------- 灯光 ----------

func (a *App) ReadLighting() (map[string]any, error) { return a.mgr.ReadLighting() }

func (a *App) SetLightingValue(valueID int, value int) error {
	if value < 0 {
		value = 0
	}
	if value > 255 {
		value = 255
	}
	return a.mgr.SetLighting(valueID, []byte{byte(value)})
}

// 颜色在 VIA 里是 2 字节（hue, sat），实测多发的字节会被固件忽略。
func (a *App) SetLightingColor(h, s, v int) error {
	if h < 0 {
		h = 0
	}
	if s < 0 {
		s = 0
	}
	return a.mgr.SetLighting(4, []byte{byte(h), byte(s)})
}

// ApplyLighting 一次性下发灯效 → 速度 → 颜色 → 亮度。
//
// 实测结论（AL80 / QMK V0103）：
//   - effect=0 时亮度和颜色都不生效（0 = 关闭/无效果），所以把它们排在最后发；
//   - 颜色只有在有效果时才被固件接收；
//   - 亮度读回会有 ±1 的量化误差，属正常；
//   - custom_save(0x09) 该固件不支持（返回 0xFF），只是本次生效、不落盘。
func (a *App) ApplyLighting(brightness, effect, speed, hue, sat int) error {
	if effect >= 0 {
		if err := a.mgr.SetLighting(2, []byte{byte(effect)}); err != nil {
			return fmt.Errorf("下发灯效失败: %w", err)
		}
	}
	if speed >= 0 {
		if err := a.mgr.SetLighting(3, []byte{byte(speed)}); err != nil {
			return fmt.Errorf("下发速度失败: %w", err)
		}
	}
	if hue >= 0 && sat >= 0 && effect != 0 {
		if err := a.mgr.SetLighting(4, []byte{byte(hue), byte(sat)}); err != nil {
			return fmt.Errorf("下发颜色失败: %w", err)
		}
	}
	if brightness >= 0 {
		if err := a.mgr.SetLighting(1, []byte{byte(brightness)}); err != nil {
			return fmt.Errorf("下发亮度失败: %w", err)
		}
	}
	// 尽力保存；固件不支持该命令时忽略
	_ = a.mgr.SaveLighting()
	return nil
}

// ---------- 屏幕 ----------

func (a *App) ScreenPreview(path string, p screen.Params) (screen.Preview, error) {
	return screen.BuildPreview(path, p)
}

// withScreenChannel 在屏幕操作期间暂停按键监听。
// 两者共用同一条 0xFF60/0x61 通道：监听每 16ms 读一次，上传时每秒写几百帧，
// 回显会把通道挤满，监听连读失败 40 次就会认为自己掉线，前端随之显示断开。
func (a *App) withScreenChannel(fn func() error) error {
	paused := false
	if a.mgr != nil {
		// 先挂起看门狗探活，再停按键监听，两层都让开这条通道
		a.mgr.BeginExclusive()
		if a.mgr.KeyWatchRunning() {
			a.mgr.StopKeyWatch()
			paused = true
		}
		time.Sleep(120 * time.Millisecond)
	}
	err := fn()
	if a.mgr != nil {
		time.Sleep(150 * time.Millisecond)
		if paused {
			if e := a.mgr.StartKeyWatch(16 * time.Millisecond); e != nil {
				logf("screen: 恢复按键监听失败 %v", e)
			}
		}
		a.mgr.EndExclusive()
	}
	return err
}
func (a *App) ScreenSend(path string, p screen.Params) (screen.SendResult, error) {
	src, _, err := screen.Decode(path)
	if err != nil {
		return screen.SendResult{}, err
	}
	canvas := screen.Fit(src, p.Width, p.Height, p.FitMode)
	raw := screen.ToRGB565(canvas, p.ByteOrder == "le")
	var res screen.SendResult
	err = a.withScreenChannel(func() error {
		var e error
		res, e = screen.Send(p, raw, func(sent, total int) {
			runtime.EventsEmit(a.ctx, "screen:progress", map[string]int{"sent": sent, "total": total})
		})
		return e
	})
	logf("screen: 上传图片 %d 字节 err=%v", len(raw), err)
	return res, err
}

// GifPreview 是给界面用的动图拆帧结果（一次性返回，避免多重返回值在 JS 侧的类型歧义）
type GifPreview struct {
	Images []string `json:"images"`
	Total  int      `json:"total"`
}

// ScreenGifFrames 把 GIF 解成逐帧 PNG（data URL），供界面做实时预览和"拆成照片"展示。
func (a *App) ScreenGifFrames(path string, p screen.Params) (GifPreview, error) {
	logf("gifframes: 开始解析 %s", path)
	// 与原厂工具一致：最多 60 帧
	frames, _, skipped, err := screen.DecodeGIF(path, 60)
	if err != nil {
		logf("gifframes: 解码失败 %v", err)
		return GifPreview{}, err
	}
	if len(frames) == 0 {
		return GifPreview{}, fmt.Errorf("这个文件里没有可用的帧")
	}
	if p.Width <= 0 {
		p.Width = 96
	}
	if p.Height <= 0 {
		p.Height = 160
	}
	out := make([]string, 0, len(frames))
	totalBytes := 0
	for _, fr := range frames {
		canvas := screen.Fit(fr, p.Width, p.Height, p.FitMode)
		var buf bytes.Buffer
		if err := png.Encode(&buf, canvas); err != nil {
			logf("gifframes: 第 %d 帧 PNG 失败 %v", len(out), err)
			return GifPreview{}, err
		}
		totalBytes += buf.Len()
		out = append(out, "data:image/png;base64,"+base64.StdEncoding.EncodeToString(buf.Bytes()))
	}
	logf("gifframes: 完成，共 %d 张，总字节 %d", len(out), totalBytes)
	return GifPreview{Images: out, Total: len(frames) + skipped}, nil
}
// ScreenSendAnimation 上传动图。boot = true 时写成开机动画。
func (a *App) ScreenSendAnimation(path string, p screen.Params, frameLimit int, boot bool) (screen.AniResult, error) {
	// frameLimit 对应原厂工具的「帧数」选项（1–60，与原厂一致）
	maxFrames := frameLimit
	if maxFrames < 1 {
		maxFrames = 1
	}
	if maxFrames > 60 {
		maxFrames = 60
	}
	frames, delays, skipped, err := screen.DecodeGIF(path, maxFrames)
	if err != nil {
		return screen.AniResult{}, err
	}
	kind := lcd.KindGifPage
	if boot {
		kind = lcd.KindBoot
	}
	var res screen.AniResult
	err = a.withScreenChannel(func() error {
		var e error
		// 帧间隔是固件恒定值 120ms（原厂工具界面里没有这个选项），只暴露「帧数」。
	for i := range delays {
		delays[i] = 120
	}
	res, e = screen.SendAnimation(p, frames, delays, 1000/120, kind, p.ChunkDelayMs)
		return e
	})
	if err == nil {
		res.Skipped = skipped
	}
	logf("screen: 上传动图 %d 帧 kind=%d 限制=%d err=%v", len(frames), kind, frameLimit, err)
	return res, err
}

func (a *App) ScreenCommand(p screen.Params, template string, arg int) error {
	err := a.withScreenChannel(func() error {
		return screen.SendCommand(p, template, arg)
	})
	logf("screen: 命令 %s(%d) err=%v", template, arg, err)
	return err
}

// ---------- 文件与配置 ----------

func (a *App) PickImage() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择屏幕图片",
		Filters: []runtime.FileFilter{
			{DisplayName: "图片 (*.png;*.jpg;*.jpeg;*.gif;*.bmp)", Pattern: "*.png;*.jpg;*.jpeg;*.gif;*.bmp"},
		},
	})
}

func (a *App) ExportConfig(content string) (string, error) {
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "导出 AL80 配置",
		DefaultFilename: "al80-config.json",
		Filters:         []runtime.FileFilter{{DisplayName: "JSON", Pattern: "*.json"}},
	})
	if err != nil || path == "" {
		return "", err
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func (a *App) ImportConfig() (string, error) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   "导入 AL80 配置",
		Filters: []runtime.FileFilter{{DisplayName: "JSON", Pattern: "*.json"}},
	})
	if err != nil || path == "" {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if !json.Valid(data) {
		return "", fmt.Errorf("不是合法的 JSON 文件")
	}
	return string(data), nil
}
