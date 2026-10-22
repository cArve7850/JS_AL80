// Package device 负责三模发现、连接与命令编排。
//
// 实测（YUNZII AL80）：
//   有线  VID 0x28E9 / PID 0x30AF  "AL80 Keyboard"      → VIA @ 0xFF60/0x61 (IN=65 OUT=65)
//   2.4G  VID 0x056D / PID 0xC077  "YUNZII AL80 2.4G"    → 暴露 0xFF87/0x20(64/64)、
//                                                          0xFF88/0x21(IN=3 只读)、0xFF00/0x01(64/64)
// 所以发现逻辑必须「逐通道握手」，不能写死一组 usage page。
package device

import (
	"fmt"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"al80-studio/internal/hidwin"
	"al80-studio/internal/macro"
	"al80-studio/internal/via"
)

// 配列常量来自 AL80_QMK_V0103 的 VIA 定义文件
const (
	Rows      = 6
	Cols      = 15
	LayerSize = Rows * Cols * 2 // 每键 2 字节
	Encoders  = 1
)

type usage struct {
	Page uint16
	ID   uint16
}

type family struct {
	Kind   string
	Label  string
	VID    uint16
	PID    uint16
	Usages []usage
}

// 候选通道按「最可能是 VIA」到「最不可能」排序，逐个握手确认。
var families = []family{
	{
		Kind: "usb", Label: "有线 (USB)", VID: 0x28E9, PID: 0x30AF,
		Usages: []usage{{0xFF60, 0x61}, {0xFF00, 0x01}, {0xFF87, 0x20}},
	},
	{
		Kind: "2.4g", Label: "2.4G (dongle)", VID: 0x056D, PID: 0xC077,
		Usages: []usage{{0xFF00, 0x01}, {0xFF60, 0x61}, {0xFF87, 0x20}},
	},
}

// 屏幕相关：厂商工具使用的 vendor collection
var screenPages = []uint16{0xFF87, 0xFF88}

// Channel 一个 HID collection 的摘要
type Channel struct {
	Path       string `json:"path"`
	Device     string `json:"device"`
	VID        string `json:"vid"`
	PID        string `json:"pid"`
	UsagePage  uint16 `json:"usagePage"`
	Usage      uint16 `json:"usage"`
	UsageText  string `json:"usageText"`
	InLen      int    `json:"inLen"`
	OutLen     int    `json:"outLen"`
	FeatureLen int    `json:"featureLen"`
	Role       string `json:"role"`
	RoleLabel  string `json:"roleLabel"`
	VIA        bool   `json:"via"`
	Note       string `json:"note,omitempty"`
}

// Status 设备栏与诊断用状态
type Status struct {
	Connected       bool      `json:"connected"`
	Path            string    `json:"path"`
	Product         string    `json:"product"`
	Manufacturer    string    `json:"manufacturer"`
	VID             string    `json:"vid"`
	PID             string    `json:"pid"`
	FirmwareVersion int       `json:"firmwareVersion"`
	Kind            string    `json:"kind"`
	KindLabel       string    `json:"kindLabel"`
	Enumerator      string    `json:"enumerator"`
	ProtocolVersion int       `json:"protocolVersion"`
	LayerCount      int       `json:"layerCount"`
	MacroCount      int       `json:"macroCount"`
	EncoderConfigurable bool  `json:"encoderConfigurable"`
	PayloadLen      int       `json:"payloadLen"`
	Layout          string    `json:"layout"`
	DonglePresent   bool      `json:"donglePresent"`
	DongleName      string    `json:"dongleName"`
	ScreenFound     bool      `json:"screenFound"`
	ScreenUsage     string    `json:"screenUsage"`
	Battery         string    `json:"battery"`
	Channels        []Channel `json:"channels"`
	Attempts        []string  `json:"attempts"`
	Warnings        []string  `json:"warnings"`
	LastError       string    `json:"lastError"`
	// UserDisconnected 表示是用户自己点了「断开」（而不是线掉了），此时看门狗不要自动重连
	UserDisconnected bool `json:"userDisconnected"`
}

type Manager struct {
	mu        sync.Mutex
	exclusive int // >0 表示正在独占通道（屏幕传输），看门狗不探活
	dev       *hidwin.Device
	client    *via.Client
	status    Status
	emit      func(event string, data any)
	stop      chan struct{}
	watchStop chan struct{}

	userDisconnected bool // 用户主动断开：看门狗不再自动重连
	wdStop           chan struct{}

	// OnAutoConnect 记录自动连接的调用来源（调试用，可为 nil）
	OnAutoConnect func(who string)
}

func NewManager(emit func(event string, data any)) *Manager {
	return &Manager{emit: emit, stop: make(chan struct{})}
}

func (m *Manager) emitEvent(name string, data any) {
	if m.emit != nil {
		m.emit(name, data)
	}
}

func (m *Manager) Scan() ([]hidwin.Info, error) { return hidwin.Enumerate() }

// Channels 汇总当前系统中与 AL80 相关的 collection
func (m *Manager) Channels() []Channel {
	infos, err := hidwin.Enumerate()
	if err != nil {
		return nil
	}
	return channelsOf(infos)
}

func channelsOf(infos []hidwin.Info) []Channel {
	var out []Channel
	for _, info := range infos {
		if !isAL80(info) {
			continue
		}
		role, roleLabel := "other", "其它"
		switch info.UsagePage {
		case 0xFF60:
			role, roleLabel = "via", "VIA 改键/灯光"
		case 0xFF88:
			role, roleLabel = "screen?", "疑似屏幕（只读 3 字节）"
		case 0xFF87:
			role, roleLabel = "control?", "疑似厂商控制"
		case 0xFF00:
			role, roleLabel = "vendor", "厂商自定义"
		}
		if info.UsagePage == 0x0001 && info.Usage == 0x80 {
			role, roleLabel = "system", "系统控制（电源/睡眠）"
		}
		if info.UsagePage == 0x000C && info.Usage == 0x01 {
			role, roleLabel = "consumer", "多媒体/音量"
		}
		note := ""
		if info.OutReportLength == 0 {
			note = "只读通道（没有 output report），不能写入"
		}
		out = append(out, Channel{
			Path:       info.Path,
			Device:     info.Product,
			VID:        fmt.Sprintf("%04X", info.VendorID),
			PID:        fmt.Sprintf("%04X", info.ProductID),
			UsagePage:  info.UsagePage,
			Usage:      info.Usage,
			UsageText:  info.UsageString(),
			InLen:      info.InReportLength,
			OutLen:     info.OutReportLength,
			FeatureLen: info.FeatureReportLen,
			Role:       role,
			RoleLabel:  roleLabel,
			Note:       note,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UsagePage != out[j].UsagePage {
			return out[i].UsagePage < out[j].UsagePage
		}
		return out[i].Usage < out[j].Usage
	})
	return out
}

func isAL80(info hidwin.Info) bool {
	for _, f := range families {
		if info.VendorID == f.VID && info.ProductID == f.PID {
			return true
		}
	}
	up := strings.ToUpper(info.Product)
	if strings.Contains(up, "AL80") || strings.Contains(up, "YUNZII") {
		return true
	}
	return false
}

type candidate struct {
	info  hidwin.Info
	kind  string
	label string
}

// candidatesOf 生成按优先级排序的候选通道列表
func candidatesOf(infos []hidwin.Info) []candidate {
	var out []candidate
	// 1) 已知家族，按预设 usage 顺序
	for _, f := range families {
		for _, u := range f.Usages {
			for _, info := range infos {
				if info.VendorID == f.VID && info.ProductID == f.PID &&
					info.UsagePage == u.Page && info.Usage == u.ID {
					out = append(out, candidate{info, f.Kind, f.Label})
				}
			}
		}
	}
	// 2) 蓝牙 / 未知固件：产品名匹配 + 常见 VIA usage
	for _, u := range []usage{{0xFF60, 0x61}, {0xFF00, 0x01}} {
		for _, info := range infos {
			if info.UsagePage != u.Page || info.Usage != u.ID {
				continue
			}
			if len(out) > 0 {
				already := false
				for _, c := range out {
					if c.info.Path == info.Path {
						already = true
						break
					}
				}
				if already {
					continue
				}
			}
			up := strings.ToUpper(info.Product)
			if !strings.Contains(up, "AL80") && !strings.Contains(up, "YUNZII") {
				continue
			}
			kind, label := "unknown", "未知连接"
			if strings.Contains(strings.ToUpper(info.Enumerator), "BTH") {
				kind, label = "ble", "蓝牙"
			}
			out = append(out, candidate{info, kind, label})
		}
	}
	return out
}

// tryConnect 依次握手，第一个通了就返回
func tryConnect(infos []hidwin.Info) (*hidwin.Device, *via.Client, Status, error) {
	cands := candidatesOf(infos)
	if len(cands) == 0 {
		return nil, nil, Status{}, fmt.Errorf("未检测到 AL80（请确认键盘已连接）")
	}
	st := Status{}
	for _, c := range cands {
		dev, err := hidwin.Open(c.info)
		if err != nil {
			st.Attempts = append(st.Attempts, fmt.Sprintf("%s %s 打开失败: %v", c.info.UsageString(), c.info.Product, err))
			continue
		}
		client := via.New(dev)
		ver, err := client.Handshake()
		if err != nil {
			st.Attempts = append(st.Attempts, fmt.Sprintf("%s 非 VIA 通道（%v）", c.info.UsageString(), err))
			dev.Close()
			continue
		}
		st.Attempts = append(st.Attempts, fmt.Sprintf("%s 握手成功，VIA v%d", c.info.UsageString(), ver))
		st.ProtocolVersion = ver
		return dev, client, st, nil
	}
	return nil, nil, st, fmt.Errorf("找到 AL80，但没有任何通道响应 VIA 协议（详见诊断）")
}

func (m *Manager) AutoConnect() (Status, error) {
	// 追溯是谁发起的一次自动连接（排查「点了断开又自己连回来」）
	if m.OnAutoConnect != nil {
		who := "unknown"
		if _, file, line, ok := runtime.Caller(1); ok {
			if i := strings.LastIndexAny(file, `\/`); i >= 0 {
				file = file[i+1:]
			}
			who = fmt.Sprintf("%s:%d", file, line)
		}
		m.OnAutoConnect(who)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.userDisconnected = false
	if m.dev != nil {
		return m.status, nil
	}
	infos, err := hidwin.Enumerate()
	if err != nil {
		return m.status, err
	}
	return m.connectLocked(infos)
}

func (m *Manager) Connect(path string) (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	infos, err := hidwin.Enumerate()
	if err != nil {
		return m.status, err
	}
	var filtered []hidwin.Info
	for _, info := range infos {
		if strings.EqualFold(info.Path, path) {
			filtered = append(filtered, info)
		}
	}
	if len(filtered) == 0 {
		return m.status, fmt.Errorf("找不到指定的 HID 通道")
	}
	// 允许用户强制指定通道：直接打开并握手
	dev, err := hidwin.Open(filtered[0])
	if err != nil {
		return m.status, err
	}
	client := via.New(dev)
	ver, err := client.Handshake()
	if err != nil {
		dev.Close()
		return m.status, fmt.Errorf("%s 不是 VIA 通道: %w", filtered[0].UsageString(), err)
	}
	return m.finishConnect(dev, client, filtered[0], "unknown", "手动指定", ver, nil)
}

func (m *Manager) connectLocked(infos []hidwin.Info) (Status, error) {
	if m.dev != nil {
		m.dev.Close()
		m.dev = nil
		m.client = nil
	}
	dev, client, st, err := tryConnect(infos)
	if err != nil {
		st.Channels = channelsOf(infos)
		st.Connected = false
		st.LastError = err.Error()
		if st.Attempts == nil {
			st.Attempts = []string{}
		}
		// 「设备在、但 VIA 不通」时给出人话提示：尤其 2.4G dongle 实测不透传 VIA。
		var seen []string
		for _, f := range families {
			for _, info := range infos {
				if info.VendorID == f.VID && info.ProductID == f.PID {
					name := firstNonEmpty(info.Product, f.Label)
					seen = append(seen, fmt.Sprintf("%s %04X:%04X", name, info.VendorID, info.ProductID))
					if f.Kind == "2.4g" && !st.DonglePresent {
						st.DonglePresent = true
						st.DongleName = name
					}
					break
				}
			}
		}
		if st.DonglePresent {
			st.Warnings = append(st.Warnings,
				"检测到 2.4G dongle（"+st.DongleName+"）：实测它的 vendor 通道不提供 VIA 接口（只接受 report ID 0x06/0x0A 的私有帧），改键和灯光请用 USB 有线模式。")
		}
		if len(seen) > 0 {
			st.LastError += "；已看到：" + strings.Join(seen, "、")
		}
		m.status = st
		return st, err
	}
	var info hidwin.Info
	for _, c := range candidatesOf(infos) {
		if c.info.Path == dev.Info.Path {
			info = c.info
			st.Kind = c.kind
			st.KindLabel = c.label
			break
		}
	}
	return m.finishConnect(dev, client, info, st.Kind, st.KindLabel, st.ProtocolVersion, st.Attempts)
}

func (m *Manager) finishConnect(dev *hidwin.Device, client *via.Client, info hidwin.Info, kind, label string, ver int, attempts []string) (Status, error) {
	m.dev = dev
	m.client = client

	if kind == "" {
		kind, label = "unknown", "未知连接"
	}
	if strings.Contains(strings.ToUpper(info.Enumerator), "BTH") {
		kind, label = "ble", "蓝牙"
	}

	st := Status{
		Connected:       true,
		Path:            info.Path,
		Product:         firstNonEmpty(info.Product, "AL80"),
		Manufacturer:    info.Manufacturer,
		VID:             fmt.Sprintf("0x%04X", info.VendorID),
		PID:             fmt.Sprintf("0x%04X", info.ProductID),
		FirmwareVersion: int(info.VersionNumber),
		Kind:            kind,
		KindLabel:       label,
		Enumerator:      info.Enumerator,
		ProtocolVersion: ver,
		PayloadLen:      client.PayloadLen(),
		Layout:          fmt.Sprintf("%dB 负载 + %d 字节 ID 前缀", client.PayloadLen(), client.Offset()),
		ScreenUsage:     "未检测到",
		Attempts:        attempts,
	}

	probe := client.DoProbe()
	st.ProtocolVersion = probe.ProtocolVersion
	st.LayerCount = probe.LayerCount
	st.MacroCount = probe.MacroCount
	st.EncoderConfigurable = probe.EncoderConfigurable
	st.Warnings = append(st.Warnings, probe.Notes...)

	chans := m.Channels()
	st.Channels = chans
	// 屏幕数据走有线设备的 0xFF60/0x61（VIA 同一条通道，report ID 0x06），已实测确认。
	for _, c := range chans {
		if c.Role == "via" {
			c.VIA = true
		}
		if c.UsagePage == 0xFF60 && c.Usage == 0x61 && c.OutLen >= 65 &&
			c.VID+":"+c.PID == "28E9:30AF" {
			st.ScreenUsage = "0xFF60/0x61（report ID 0x06，96×160）"
		}
	}
	if st.Kind == "2.4g" {
		st.Warnings = append(st.Warnings,
			"当前是 2.4G 连接：实测 dongle 下 VIA 走 "+info.UsageString()+"（不是 0xFF60），命令已验证可用。")
	}
	if st.Kind == "ble" {
		st.Warnings = append(st.Warnings,
			"蓝牙模式下固件是否接受 Raw HID 命令尚未验证：若改键/灯光无反应，请改用有线或 2.4G。")
	}

	m.status = st
	m.emitEvent("device:changed", st)
	return st, nil
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

func (m *Manager) Disconnect() Status {
	m.StopKeyWatch()
	m.mu.Lock()
	if m.dev != nil {
		m.dev.Close()
	}
	m.dev, m.client = nil, nil
	m.userDisconnected = true
	m.status = Status{Connected: false, UserDisconnected: true}
	m.mu.Unlock()
	m.emitEvent("device:changed", m.status)
	return m.status
}

// StartWatchdog 启动热插拔看门狗：掉线自动重连、插上自动识别（用户主动断开的除外）
func (m *Manager) StartWatchdog(interval time.Duration) {
	m.mu.Lock()
	if m.wdStop != nil {
		m.mu.Unlock()
		return
	}
	stop := make(chan struct{})
	m.wdStop = stop
	m.mu.Unlock()

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		fails := 0
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
			}

			m.mu.Lock()
			connected := m.dev != nil
			skip := m.userDisconnected
			busy := m.exclusive > 0
			m.mu.Unlock()

			if busy {
				// 屏幕正在传输：这一轮不探活，也不累加失败计数
				fails = 0
				continue
			}

			if connected {
				if err := m.livenessProbe(); err != nil {
					fails++
					if fails >= 2 {
						fails = 0
						m.dropAndNotice(err)
					}
				} else {
					fails = 0
				}
				continue
			}
			if skip {
				continue
			}
			// 未连接且不是用户主动断开：尝试自动连上（插上键盘即自动识别）
			if st, err := m.AutoConnect(); err == nil && st.Connected {
				m.emitEvent("device:changed", st)
			}
		}
	}()
}

// StopWatchdog 停止看门狗
func (m *Manager) StopWatchdog() {
	m.mu.Lock()
	if m.wdStop != nil {
		close(m.wdStop)
		m.wdStop = nil
	}
	m.mu.Unlock()
}

// livenessProbe 轻量探活：一次 VIA 往返，够判断句柄是否还有效
func (m *Manager) livenessProbe() error {
	m.mu.Lock()
	c := m.client
	m.mu.Unlock()
	if c == nil {
		return fmt.Errorf("命令通道已失效")
	}
	_, err := c.ProtocolVersion()
	return err
}

// dropAndNotice 连接已失效：清掉句柄并告知界面，随后由看门狗自动重连
func (m *Manager) dropAndNotice(cause error) {
	m.mu.Lock()
	if m.dev != nil {
		m.dev.Close()
	}
	m.dev, m.client = nil, nil
	m.status = Status{
		Connected:  false,
		LastError:  "键盘连接中断（" + cause.Error() + "），正在自动重连…",
		Warnings:   []string{"如果一直连不上，请插好 USB 线（2.4G/蓝牙模式不支持改键）"},
	}
	st := m.status
	m.mu.Unlock()
	m.StopKeyWatch()
	m.emitEvent("device:changed", st)
}

// ForceDropForTest 仅测试用：不清理状态地关掉句柄，模拟「线被拔掉」
func (m *Manager) ForceDropForTest() {
	m.mu.Lock()
	dev := m.dev
	m.mu.Unlock()
	if dev != nil {
		dev.Close()
	}
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status
}

func (m *Manager) clientLocked() (*via.Client, error) {
	if m.client == nil {
		return nil, fmt.Errorf("设备未连接")
	}
	return m.client, nil
}

func (m *Manager) Stop() {
	m.StopWatchdog()
	close(m.stop)
}

// ---------- 按键 ----------

func (m *Manager) ReadKeymap() (map[string]any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, err := m.clientLocked()
	if err != nil {
		return nil, err
	}
	layers := m.status.LayerCount
	if layers <= 0 {
		layers = 4
	}
	out := make([][]uint16, layers)
	for l := 0; l < layers; l++ {
		raw, err := c.GetKeymapBuffer(l, LayerSize)
		if err != nil {
			return nil, err
		}
		vals := make([]uint16, Rows*Cols)
		for i := 0; i < Rows*Cols; i++ {
			vals[i] = uint16(raw[i*2])<<8 | uint16(raw[i*2+1])
		}
		out[l] = vals
	}
	// 旋钮：只有在固件支持时才读方向键值，否则返回空表（前端据此禁用编辑）
	enc := make([][2]uint16, 0)
	if m.status.EncoderConfigurable {
		enc = make([][2]uint16, layers)
		for l := 0; l < layers; l++ {
			// [0] = 顺时针（固件不回报，恒为 0），[1] = 逆时针（可读回）
			if kc, err := c.GetEncoderKey(l, 0); err == nil {
				enc[l] = [2]uint16{0, kc}
			}
		}
	}
	return map[string]any{
		"rows":     Rows,
		"cols":     Cols,
		"layers":   out,
		"encoders": enc,
	}, nil
}

func (m *Manager) SetKeycode(layer, row, col int, keycode uint16) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, err := m.clientLocked()
	if err != nil {
		return err
	}
	if row < 0 || row >= Rows || col < 0 || col >= Cols {
		return fmt.Errorf("按键坐标越界: %d,%d", row, col)
	}
	return c.SetKeycode(layer, row, col, keycode)
}

// SetEncoderKey 写入旋钮旋转键码。clockwise=false 写「逆时针」槽位（可读回），
// clockwise=true 写「顺时针」槽位：固件不回报该槽位，只能两个候选位置都写一次。
func (m *Manager) SetEncoderKey(layer int, clockwise bool, keycode uint16) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, err := m.clientLocked()
	if err != nil {
		return err
	}
	if layer < 0 || layer >= 4 {
		return fmt.Errorf("层越界: %d", layer)
	}
	if clockwise {
		if err := c.SetEncoderRaw(layer, 1, 0, keycode); err != nil {
			return err
		}
		return c.SetEncoderRaw(layer, 0, 1, keycode)
	}
	return c.SetEncoderRaw(layer, 0, 0, keycode)
}

// ---------- 灯光 ----------

func (m *Manager) SetLighting(valueID int, values []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, err := m.clientLocked()
	if err != nil {
		return err
	}
	return c.SetLightingValue(byte(valueID), values)
}

// MacroSlot 一个宏槽位的当前内容
type MacroSlot struct {
	Index int    `json:"index"`
	Text  string `json:"text"`
	Bytes int    `json:"bytes"`
}

// MacroInfo 宏区整体信息
type MacroInfo struct {
	Count     int         `json:"count"`
	BufferSize int        `json:"bufferSize"`
	Stride    int         `json:"stride"`
	UsedBytes int         `json:"usedBytes"`
	Slots     []MacroSlot `json:"slots"`
}

func (m *Manager) ReadMacros() (MacroInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, err := m.clientLocked()
	if err != nil {
		return MacroInfo{}, err
	}
	count, err := c.MacroCount()
	if err != nil {
		return MacroInfo{}, err
	}
	size, err := c.MacroBufferSize()
	if err != nil {
		return MacroInfo{}, err
	}
	if count <= 0 {
		return MacroInfo{Count: count, BufferSize: size}, nil
	}
	stride := size / count
	// 整块读（每次 48 字节，留足 VIA 头部空间）
	raw := make([]byte, 0, size)
	for off := 0; off < size; off += 48 {
		want := 48
		if off+want > size {
			want = size - off
		}
		b, err := c.MacroBuffer(off, want)
		if err != nil {
			return MacroInfo{}, err
		}
		raw = append(raw, b...)
	}
	info := MacroInfo{Count: count, BufferSize: size, Stride: stride}
	for i := 0; i < count; i++ {
		start := i * stride
		end := start + stride
		if end > len(raw) {
			end = len(raw)
		}
		if start >= end {
			break
		}
		slot := raw[start:end]
		used := 0
		for used < len(slot) && slot[used] != 0 {
			used++
		}
		text := ""
		if used > 0 {
			text = macro.Decode(slot[:used])
		}
		info.Slots = append(info.Slots, MacroSlot{Index: i, Text: text, Bytes: used})
		info.UsedBytes += used
	}
	return info, nil
}

// WriteMacros 把文本编码后写进宏区；只写有内容的槽位，空槽只写一个 0 结束符。
func (m *Manager) WriteMacros(texts []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, err := m.clientLocked()
	if err != nil {
		return err
	}
	count, err := c.MacroCount()
	if err != nil {
		return err
	}
	size, err := c.MacroBufferSize()
	if err != nil {
		return err
	}
	if count <= 0 {
		return fmt.Errorf("固件没有宏区")
	}
	stride := size / count
	for i, text := range texts {
		if i >= count {
			break
		}
		start := i * stride
		if strings.TrimSpace(text) == "" {
			// 一个 0 字节就能让该槽位变空（NUL 结尾）
			if err := c.MacroSetBuffer(start, []byte{0}); err != nil {
				return fmt.Errorf("清空第 %d 个宏失败: %w", i, err)
			}
			continue
		}
		enc, err := macro.Encode(text)
		if err != nil {
			return fmt.Errorf("第 %d 个宏（M%d）：%w", i, i, err)
		}
		if len(enc)+1 > stride {
			return fmt.Errorf("第 %d 个宏太长：%d 字节，上限 %d", i, len(enc)+1, stride)
		}
		payload := append(enc, 0)
		for off := 0; off < len(payload); off += 48 {
			end := off + 48
			if end > len(payload) {
				end = len(payload)
			}
			if err := c.MacroSetBuffer(start+off, payload[off:end]); err != nil {
				return fmt.Errorf("写第 %d 个宏失败（偏移 %d）: %w", i, off, err)
			}
		}
	}
	return nil
}

func (m *Manager) ClearMacros() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, err := m.clientLocked()
	if err != nil {
		return err
	}
	return c.MacroReset()
}
func (m *Manager) SaveLighting() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, err := m.clientLocked()
	if err != nil {
		return err
	}
	return c.CustomSave()
}

func (m *Manager) ReadLighting() (map[string]any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, err := m.clientLocked()
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	if v, err := c.GetLightingValue(via.LightValueBrightness); err == nil {
		out["brightness"] = int(v[0])
	}
	if v, err := c.GetLightingValue(via.LightValueEffect); err == nil {
		out["effect"] = int(v[0])
	}
	if v, err := c.GetLightingValue(via.LightValueSpeed); err == nil {
		out["speed"] = int(v[0])
	}
	if v, err := c.GetLightingValue(via.LightValueColor); err == nil {
		out["hue"] = int(v[0])
		out["sat"] = int(v[1])
		out["val"] = int(v[2])
	}
	return out, nil
}

// ---------- 实时按键监测 ----------

// KeyWatchState 一次矩阵采样结果（只在本机事件通道里用）
type KeyWatchState struct {
	Active  bool     `json:"active"`
	Pressed [][2]int `json:"pressed"`
	Error   string   `json:"error,omitempty"`
	Rows    []uint16 `json:"rows,omitempty"`
	// Ts 是这一帧读完的 Unix 毫秒时间戳，LatMs 是读一次矩阵花掉的毫秒数。
	// 前端用 Date.now()-Ts+LatMs 估算「从按下到画面更新」的检测延迟。
	Ts    int64   `json:"ts"`
	LatMs float64 `json:"latMs"`
}

// StartKeyWatch 轮询键盘原始矩阵状态，按下的键变化时通过 key:watch 事件推给前端。
// BeginExclusive / EndExclusive 标记"通道被独占"（屏幕上传期间）。
// 上传时每秒写几百帧，看门狗的 VIA 探活必然超时；不挡住它会误判掉线并重连。
func (m *Manager) BeginExclusive() {
	m.mu.Lock()
	m.exclusive++
	m.mu.Unlock()
}

func (m *Manager) EndExclusive() {
	m.mu.Lock()
	if m.exclusive > 0 {
		m.exclusive--
	}
	m.mu.Unlock()
}

func (m *Manager) exclusiveBusy() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.exclusive > 0
}
// KeyWatchRunning 报告按键监听是否在跑（屏幕上传期间要暂停它）。
func (m *Manager) KeyWatchRunning() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.watchStop != nil
}
func (m *Manager) StartKeyWatch(interval time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.client == nil {
		return fmt.Errorf("设备未连接")
	}
	if m.watchStop != nil {
		return nil
	}
	stop := make(chan struct{})
	m.watchStop = stop
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		fails := 0
		lastSig := ""
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
			}
			readStart := time.Now()
			rows, err := m.readMatrix()
			latMs := float64(time.Since(readStart).Microseconds()) / 1000
			if err != nil {
				// 单次失败很常见：下发灯光/键位时通道被占用、USB 抖动。不轻易停：
				// 先提示「正在重试」，继续重试；恢复后自动续上；只有长期读不到才彻底停。
				fails++
				if fails == 3 {
					m.emitEvent("key:watch", KeyWatchState{Active: false, Error: "矩阵读取暂时失败，正在重试：" + err.Error()})
				}
				if fails >= 40 { // 40ms × 40 ≈ 1.6 秒仍读不到，才认为设备真的没了
					m.emitEvent("key:watch", KeyWatchState{Active: false, Error: "键盘没有响应矩阵状态查询：" + err.Error()})
					m.mu.Lock()
					if m.watchStop == stop {
						m.watchStop = nil
					}
					m.mu.Unlock()
					return
				}
				continue
			}
			if fails >= 3 {
				m.emitEvent("key:watch", KeyWatchState{Active: true})
			}
			fails = 0

			pressed := make([][2]int, 0, 8)
			for r, bits := range rows {
				for c := 0; c < Cols; c++ {
					if bits&(1<<uint(c)) != 0 {
						pressed = append(pressed, [2]int{r, c})
					}
				}
			}
			// 只在矩阵真的变化时推送：按住不放时前端自己维持高亮（45ms 余晖），
			// 这样 60 帧/秒的空转推送就省掉了，界面不再被无意义的重渲染拖慢。
			sig := fmt.Sprint(rows)
			if sig == lastSig {
				continue
			}
			lastSig = sig
			m.emitEvent("key:watch", KeyWatchState{
				Active:  true,
				Pressed: pressed,
				Rows:    rows,
				Ts:      time.Now().UnixMilli(),
				LatMs:   latMs,
			})
		}
	}()
	return nil
}

func (m *Manager) readMatrix() ([]uint16, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.client == nil {
		return nil, fmt.Errorf("设备未连接")
	}
	return m.client.MatrixState(Rows)
}

// StopKeyWatch 停止轮询
func (m *Manager) StopKeyWatch() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.watchStop != nil {
		close(m.watchStop)
		m.watchStop = nil
	}
}

// ---------- 诊断 ----------

type DiagResult struct {
	Devices    []hidwin.Info `json:"devices"`
	Matched    []Channel     `json:"matched"`
	Status     Status        `json:"status"`
	ReportText string        `json:"reportText"`
}

// Check 一项能力自检结果
type Check struct {
	Name   string `json:"name"`
	Ok     bool   `json:"ok"`
	Detail string `json:"detail"`
	Hint   string `json:"hint,omitempty"`
}

// SelfCheck 是只读（或写回原值）的自检结果
type SelfCheck struct {
	Checks     []Check `json:"checks"`
	ReportText string  `json:"reportText"`
	OkCount    int     `json:"okCount"`
	FailCount  int     `json:"failCount"`
}

// SelfCheck 逐项验证这台机器上到底哪些功能真的能用。
// 所有写入都是「读出来再原样写回去」，不会改变键盘内容。
func (m *Manager) SelfCheck() SelfCheck {
	res := SelfCheck{Checks: []Check{}}
	add := func(name string, ok bool, detail, hint string) {
		res.Checks = append(res.Checks, Check{Name: name, Ok: ok, Detail: detail, Hint: hint})
	}

	st := m.Status()
	if !st.Connected {
		add("设备连接", false, "未连接", "插上 USB 线，或用 2.4G/蓝牙后点「重新扫描」")
		res.ReportText = m.selfCheckText(res)
		return res
	}
	add("设备连接", true, fmt.Sprintf("%s（%s）%s", st.Product, st.KindLabel, st.VID+":"+st.PID), "")
	add("VIA 协议", st.ProtocolVersion > 0,
		fmt.Sprintf("协议 v%d，负载 %dB，%s", st.ProtocolVersion, st.PayloadLen, st.Layout), "")

	m.mu.Lock()
	c := m.client
	m.mu.Unlock()

	if c == nil {
		add("命令通道", false, "客户端未就绪", "断开后重新连接")
		res.ReportText = m.selfCheckText(res)
		return res
	}

	// 1) 键位读取
	var kc uint16
	var err error
	if kc, err = c.GetKeycode(0, 0, 0); err != nil {
		add("键位读取", false, err.Error(), "")
	} else {
		add("键位读取", true, fmt.Sprintf("第 1 层 [0,0] = 0x%04X", kc), "")
	}

	// 2) 键位写入（原值写回，不改内容）
	if kc != 0 || err == nil {
		werr := c.SetKeycode(0, 0, 0, kc)
		if werr != nil {
			add("键位写入", false, werr.Error(), "")
		} else if back, rerr := c.GetKeycode(0, 0, 0); rerr != nil || back != kc {
			add("键位写入", false, fmt.Sprintf("写回后读回 0x%04X（期望 0x%04X）", back, kc), "")
		} else {
			add("键位写入", true, fmt.Sprintf("原值 0x%04X 写回校验一致", kc), "")
		}
	}

	// 3) 按键矩阵（按键高亮依赖它）
	if rows, merr := m.readMatrix(); merr != nil {
		add("按键矩阵读取", false, merr.Error(), "该功能不可用则按键页不会实时高亮")
	} else {
		add("按键矩阵读取", true, fmt.Sprintf("%d 行状态已读到（行掩码 %04X…）", len(rows), rows[0]), "")
	}

	// 4) 灯光读取（通道 3 亮度/灯效/速度/颜色）
	var bright, effect byte
	if v, err := c.GetLightingValue(via.LightValueBrightness); err != nil {
		add("灯光读取", false, err.Error(), "")
	} else {
		bright = v[0]
		d := fmt.Sprintf("亮度 %d", bright)
		if e, err2 := c.GetLightingValue(via.LightValueEffect); err2 == nil {
			effect = e[0]
			d += fmt.Sprintf("，灯效索引 %d", effect)
		}
		add("灯光读取", true, d, "")
	}

	// 5) 灯光写入（同值写回）
	if verr := c.SetLightingValue(via.LightValueBrightness, []byte{bright}); verr != nil {
		add("灯光写入", false, verr.Error(), "")
	} else {
		add("灯光写入", true, fmt.Sprintf("亮度 %d 原值写回成功", bright), "")
	}

	// 6) 宏
	if n, err := c.MacroCount(); err != nil {
		add("宏", false, err.Error(), "")
	} else if size, err2 := c.MacroBufferSize(); err2 != nil {
		add("宏", false, err2.Error(), "")
	} else {
		add("宏", true, fmt.Sprintf("%d 条，缓冲区 %d 字节（每槽 %d）", n, size, size/maxI(n, 1)), "")
	}

	// 7) 旋钮
	if st.EncoderConfigurable {
		add("旋钮旋转改键", true, "固件支持 set_encoder", "")
	} else {
		add("旋钮旋转改键", false, "固件忽略 set_encoder（实测）", "旋钮「按下」是普通按键，可以改")
	}

	// 8) 屏幕通道：屏幕数据走有线设备的 0xFF60/0x61（report ID 0x06），已实测确认
	chans := channelsOf(m.allInfos())
	screenOK := false
	var dongleOnly []string
	for _, ch := range chans {
		if ch.UsagePage == 0xFF60 && ch.Usage == 0x61 && ch.OutLen >= 65 &&
			ch.VID+":"+ch.PID == "28E9:30AF" {
			screenOK = true
		}
		if ch.OutLen > 0 && ch.UsagePage != 0xFF60 && ch.UsagePage != 0xFF31 &&
			ch.VID+":"+ch.PID != "28E9:30AF" {
			dongleOnly = append(dongleOnly, fmt.Sprintf("%s（OUT=%d）", ch.UsageText, ch.OutLen))
		}
	}
	if screenOK {
		add("屏幕上传通道", true, "有线 0xFF60/0x61（65 字节，report ID 0x06）",
			"96×160 RGB565，一屏 552 帧；开始帧后需等约 350ms 擦闪存")
	} else {
		add("屏幕上传通道", false, "没找到键盘的 0xFF60/0x61 通道",
			"屏幕上传需要键盘用数据线连接；2.4G 接收器上的通道固件不接受这种帧")
	}
	if len(dongleOnly) > 0 {
		add("2.4G 通道（参考）", true, "另外看到："+strings.Join(dongleOnly, "、"),
			"这些属于 2.4G 接收器；厂商工具的无线下发也走这类通道")
	}

	// 9) 2.4G
	if st.DonglePresent {
		add("2.4G dongle", false, "检测到 "+st.DongleName+"，但它不透传 VIA",
			"改键/灯光请用 USB 有线模式")
	} else {
		add("2.4G dongle", true, "未检测到（当前不影响使用）", "")
	}

	res = m.fillCounts(res)
	res.ReportText = m.selfCheckText(res)
	return res
}

func (m *Manager) allInfos() []hidwin.Info {
	infos, err := hidwin.Enumerate()
	if err != nil {
		return nil
	}
	return infos
}

func (m *Manager) selfCheckText(res SelfCheck) string {
	var sb strings.Builder
	sb.WriteString("=== AL80 Studio 能力自检 ===\n")
	sb.WriteString(time.Now().Format("2006-01-02 15:04:05") + "\n\n")
	ok, fail := 0, 0
	for _, ck := range res.Checks {
		mark := "[OK]  "
		if !ck.Ok {
			mark = "[FAIL]"
			fail++
		} else {
			ok++
		}
		sb.WriteString(fmt.Sprintf("%s %s：%s\n", mark, ck.Name, ck.Detail))
		if ck.Hint != "" {
			sb.WriteString("        提示：" + ck.Hint + "\n")
		}
	}
	sb.WriteString(fmt.Sprintf("\n合计：可用 %d 项，不可用 %d 项\n", ok, fail))
	return sb.String()
}
func (m *Manager) Diagnose() (DiagResult, error) {
	infos, err := hidwin.Enumerate()
	if err != nil {
		return DiagResult{}, err
	}
	res := DiagResult{Devices: infos, Matched: channelsOf(infos), Status: m.Status()}

	var sb strings.Builder
	sb.WriteString("=== AL80 诊断报告 ===\n")
	sb.WriteString(fmt.Sprintf("HID collection 总数: %d\n\n", len(infos)))
	sb.WriteString("--- AL80 相关通道 ---\n")
	for _, c := range res.Matched {
		sb.WriteString(fmt.Sprintf("%s IN=%d OUT=%d FEATURE=%d 角色=%s %s\n",
			c.UsageText, c.InLen, c.OutLen, c.FeatureLen, c.Role, c.Note))
	}
	sb.WriteString("\n--- 连接状态 ---\n")
	st := res.Status
	sb.WriteString(fmt.Sprintf("已连接=%v 方式=%s 通道=%s\n", st.Connected, st.KindLabel, st.Path))
	sb.WriteString(fmt.Sprintf("VIA v%d 负载=%dB 布局=%s\n", st.ProtocolVersion, st.PayloadLen, st.Layout))
	sb.WriteString(fmt.Sprintf("层数=%d 宏=%d encoder=%v\n", st.LayerCount, st.MacroCount, st.EncoderConfigurable))
	for _, a := range st.Attempts {
		sb.WriteString("尝试: " + a + "\n")
	}
	for _, w := range st.Warnings {
		sb.WriteString("警告: " + w + "\n")
	}
	sb.WriteString("\n--- 全部 HID 设备 ---\n")
	for _, i := range infos {
		sb.WriteString(fmt.Sprintf("%s usage=%s IN=%d OUT=%d %s [%s] %s\n",
			i.VIDPIDSring(), i.UsageString(), i.InReportLength, i.OutReportLength,
			i.Product, i.Enumerator, i.OpenError))
	}
	res.ReportText = sb.String()
	return res, nil
}

func maxI(a, b int) int {
	if a > b {
		return a
	}
	return b
}
// fillCounts 统计自检通过/未通过数量
func (m *Manager) fillCounts(res SelfCheck) SelfCheck {
	ok, fail := 0, 0
	for _, ck := range res.Checks {
		if ck.Ok {
			ok++
		} else {
			fail++
		}
	}
	res.OkCount, res.FailCount = ok, fail
	return res
}