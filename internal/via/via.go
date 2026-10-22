// Package via 实现 QMK Raw HID 上的 VIA 协议（协议版本 12）。
//
// 实测结论（YUNZII AL80）：
//  1. 有线 0xFF60/0x61 IN=65 OUT=65：请求 = [reportID(0)][payload...]，
//     响应 = [reportID][payload...]，payload 长度 64。
//  2. QMK 的响应会把命令 ID 回声在 payload[0]，真正的数据从 payload[1] 开始。
//     例如 get_protocol_version 返回 01 00 0C → 命令 0x01、版本 0x000C(12)。
//  3. keymap buffer 的请求是 [id, offset_hi, offset_lo, size]，
//     offset 是「跨所有层」的全局字节偏移（不是层内偏移）。
//  4. 灯光走 qmk_lighting 自定义通道 3：请求 [id, channel, value_id, data...]，
//     响应 [id, channel, value_id, value...]，即值从 payload[3] 开始。
package via

import (
	"encoding/binary"
	"errors"
	"fmt"
	"time"

	"al80-studio/internal/hidwin"
)

const (
	IDGetProtocolVersion      = 0x01
	IDGetKeyboardValue        = 0x02
	IDSetKeyboardValue        = 0x03
	IDDynamicKeymapGetKeycode = 0x04
	IDDynamicKeymapSetKeycode = 0x05
	IDDynamicKeymapReset      = 0x06
	IDCustomSetValue          = 0x07
	IDCustomGetValue          = 0x08
	IDCustomSave              = 0x09
	IDEEPROMReset             = 0x0A
	IDMacroGetCount           = 0x0C
	IDMacroGetBufferSize      = 0x0D
	IDMacroGetBuffer          = 0x0E
	IDMacroSetBuffer          = 0x0F
	IDMacroReset              = 0x10
	IDDynamicKeymapGetLayers  = 0x11
	IDDynamicKeymapGetBuffer  = 0x12
	IDDynamicKeymapSetBuffer  = 0x13
	IDDynamicKeymapGetEncoder = 0x14
	IDDynamicKeymapSetEncoder = 0x15
)

// 灯光通道（qmk_lighting）：channel 3 = RGB Matrix
const (
	LightChannelRGBMatrix = 3
	LightValueBrightness  = 1
	LightValueEffect      = 2
	LightValueSpeed       = 3
	LightValueColor       = 4
)

// ErrHandshake 表示该通道不是 VIA 通道。
var ErrHandshake = errors.New("该通道没有响应 VIA 协议")

type Client struct {
	dev        *hidwin.Device
	payloadLen int           // 每包有效负载长度（32 或 64）
	off        int           // payload 在缓冲区中的起始偏移（1 = 前面有 report ID 字节）
	id         byte          // report ID 字节
	timeout    time.Duration // 等待响应超时
}

func New(dev *hidwin.Device) *Client {
	out := dev.Info.OutReportLength
	inLen := dev.Info.InReportLength
	size := out
	if inLen > size {
		size = inLen
	}
	payload := 32
	if size >= 64 {
		payload = 64
	}
	off := 0
	if size > payload {
		off = 1
	}
	return &Client{
		dev:        dev,
		payloadLen: payload,
		off:        off,
		id:         0,
		timeout:    600 * time.Millisecond,
	}
}

func (c *Client) PayloadLen() int { return c.payloadLen }
func (c *Client) Offset() int     { return c.off }
func (c *Client) Device() *hidwin.Device {
	return c.dev
}

func (c *Client) buildFrame(payload []byte) []byte {
	size := c.dev.Info.OutReportLength
	if size < c.off+len(payload) {
		size = c.off + len(payload)
	}
	buf := make([]byte, size)
	if c.off > 0 {
		buf[0] = c.id
	}
	copy(buf[c.off:], payload)
	return buf
}

// call 发送命令并返回响应 payload（已去掉 report ID 前缀，payload[0] 为回声的命令 ID）。
func (c *Client) call(payload []byte) ([]byte, error) {
	if len(payload) > c.payloadLen {
		return nil, fmt.Errorf("VIA 负载 %d 字节超过通道上限 %d", len(payload), c.payloadLen)
	}
	frame := c.buildFrame(payload)

	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		c.dev.Drain()
		if err := c.dev.WriteRawTimeout(frame, 900*time.Millisecond); err != nil {
			lastErr = err
			time.Sleep(40 * time.Millisecond)
			continue
		}
		resp, ok := c.dev.TryRead(c.timeout)
		if !ok {
			lastErr = fmt.Errorf("设备无响应（命令 0x%02X）", payload[0])
			time.Sleep(40 * time.Millisecond)
			continue
		}
		var out []byte
		if len(resp) > c.payloadLen {
			out = resp[len(resp)-c.payloadLen:]
		} else {
			out = resp
		}
		if len(out) > 0 && out[0] != payload[0] {
			lastErr = fmt.Errorf("响应命令 ID 不匹配（期望 0x%02X，收到 0x%02X）", payload[0], out[0])
			time.Sleep(20 * time.Millisecond)
			continue
		}
		return out, nil
	}
	if lastErr == nil {
		lastErr = errors.New("VIA 命令失败")
	}
	return nil, lastErr
}

// Handshake 探测通道是否真的实现 VIA：命令回声 + 合理版本号。
func (c *Client) Handshake() (int, error) {
	resp, err := c.call([]byte{IDGetProtocolVersion})
	if err != nil {
		return 0, err
	}
	if len(resp) < 3 {
		return 0, fmt.Errorf("%w（响应过短 %d 字节）", ErrHandshake, len(resp))
	}
	ver := int(binary.BigEndian.Uint16(resp[1:3]))
	if ver <= 0 || ver > 100 {
		return 0, fmt.Errorf("%w（版本号异常 %d）", ErrHandshake, ver)
	}
	return ver, nil
}

func (c *Client) ProtocolVersion() (int, error) {
	resp, err := c.call([]byte{IDGetProtocolVersion})
	if err != nil {
		return 0, err
	}
	return int(binary.BigEndian.Uint16(resp[1:3])), nil
}

func (c *Client) LayerCount() (int, error) {
	resp, err := c.call([]byte{IDDynamicKeymapGetLayers})
	if err != nil {
		return 0, err
	}
	return int(resp[1]), nil
}

func (c *Client) MacroCount() (int, error) {
	resp, err := c.call([]byte{IDMacroGetCount})
	if err != nil {
		return 0, err
	}
	return int(resp[1]), nil
}

// MacroSetBuffer 写入宏缓冲区的一段（offset 为全局偏移）。
func (c *Client) MacroSetBuffer(offset int, data []byte) error {
	req := append([]byte{IDMacroSetBuffer, byte(offset >> 8), byte(offset), byte(len(data))}, data...)
	_, err := c.call(req)
	return err
}

// MacroReset 清空所有宏（VIA id_macro_reset）。
func (c *Client) MacroReset() error {
	_, err := c.call([]byte{IDMacroReset})
	return err
}
// MacroBufferSize 返回宏缓冲区总字节数（VIA id_macro_get_buffer_size）。
func (c *Client) MacroBufferSize() (int, error) {
	resp, err := c.call([]byte{IDMacroGetBufferSize})
	if err != nil {
		return 0, err
	}
	if len(resp) < 3 {
		return 0, fmt.Errorf("宏缓冲区响应过短（%d 字节）", len(resp))
	}
	return int(resp[1])<<8 | int(resp[2]), nil
}

// MacroBuffer 读取宏缓冲区的一段（offset 为全局偏移，同 VIA 约定）。
func (c *Client) MacroBuffer(offset, size int) ([]byte, error) {
	req := []byte{IDMacroGetBuffer, byte(offset >> 8), byte(offset), byte(size)}
	resp, err := c.call(req)
	if err != nil {
		return nil, err
	}
	if len(resp) < 4 {
		return nil, fmt.Errorf("宏缓冲区响应过短（%d 字节）", len(resp))
	}
	data := resp[4:]
	if len(data) > size {
		data = data[:size]
	}
	return data, nil
}
// GetKeymapBuffer 读取一层 keymap（offset 为跨层全局字节偏移）。
func (c *Client) GetKeymapBuffer(layer, layerBytes int) ([]byte, error) {
	base := layer * layerBytes
	out := make([]byte, 0, layerBytes)
	chunk := c.payloadLen - 4
	if chunk <= 0 {
		return nil, errors.New("通道负载太小，无法读取 keymap")
	}
	for local := 0; local < layerBytes; local += chunk {
		size := layerBytes - local
		if size > chunk {
			size = chunk
		}
		offset := base + local
		resp, err := c.call([]byte{
			IDDynamicKeymapGetBuffer, byte(offset >> 8), byte(offset), byte(size),
		})
		if err != nil {
			return nil, fmt.Errorf("读取第 %d 层 keymap 失败(offset %d): %w", layer, offset, err)
		}
		// 回显 cmd(0x12)+offsetHi+offsetLo+size 之后才是数据
		if len(resp) < 4+int(size) {
			return nil, fmt.Errorf("keymap 响应长度不足（%d < %d）", len(resp), 4+int(size))
		}
		out = append(out, resp[4:4+int(size)]...)
	}
	return out, nil
}

func (c *Client) GetKeycode(layer, row, col int) (uint16, error) {
	resp, err := c.call([]byte{IDDynamicKeymapGetKeycode, byte(layer), byte(row), byte(col)})
	if err != nil {
		return 0, err
	}
	// 回显 cmd(0x04)+layer+row+col 后才是 keycode
	return binary.BigEndian.Uint16(resp[4:6]), nil
}

func (c *Client) SetKeycode(layer, row, col int, keycode uint16) error {
	_, err := c.call([]byte{
		IDDynamicKeymapSetKeycode, byte(layer), byte(row), byte(col),
		byte(keycode >> 8), byte(keycode),
	})
	return err
}

// RawCall 直接发一条 VIA 命令并返回响应（诊断用）。
func (c *Client) RawCall(payload []byte) ([]byte, error) {
	return c.call(payload)
}

// GetEncoderKey 读取某层旋钮（索引 0）当前绑定的键码。
//
// 响应格式（实测 AL80 QMK V0103）：
//
//	payload[0]=0x14, [1]=层, [2]=索引, [3]=方向, [4..5]=键码（大端）
//
// 四层的默认值都是 0x00AA（KC_AUDIO_VOL_DOWN）。
func (c *Client) GetEncoderKey(layer, index int) (uint16, error) {
	resp, err := c.call([]byte{IDDynamicKeymapGetEncoder, byte(layer), byte(index)})
	if err != nil {
		return 0, err
	}
	if len(resp) < 6 {
		return 0, fmt.Errorf("encoder 响应过短（%d 字节）", len(resp))
	}
	return binary.BigEndian.Uint16(resp[4:6]), nil
}

// SetEncoderKey 写入旋钮键码。
//
// 负载格式必须是 [id, 层, 索引, 方向, 键码高, 键码低]：
// 早期版本多发了两字节（一次性发 CW+CCW 四个字节），固件把整条命令丢弃，
// 于是误判成「固件不支持改旋钮」。实测只有方向 0 能写入并读回，
// 方向 1 写入无效。
func (c *Client) SetEncoderKey(layer, index int, keycode uint16) error {
	return c.SetEncoderRaw(layer, index, 0, keycode)
}

// SetEncoderRaw 按原始 [层, 索引, 方向, 键码高, 键码低] 写入旋钮槽位。
//
// 探测结论（AL80 / QMK V0103）：
//   - 方向 0 的槽位能读能写，响应里出现在 payload[4..5]，对应「逆时针」；
//   - 「顺时针」的槽位能写但固件不回报，候选位置是 (索引 1, 方向 0) 或 (索引 0, 方向 1)。
func (c *Client) SetEncoderRaw(layer, index, dir int, keycode uint16) error {
	_, err := c.call([]byte{
		IDDynamicKeymapSetEncoder, byte(layer), byte(index), byte(dir),
		byte(keycode >> 8), byte(keycode),
	})
	return err
}

func (c *Client) ResetKeymap() error {
	_, err := c.call([]byte{IDDynamicKeymapReset})
	return err
}

func (c *Client) CustomSet(channel, valueID byte, data []byte) error {
	payload := append([]byte{IDCustomSetValue, channel, valueID}, data...)
	_, err := c.call(payload)
	return err
}

// CustomGet 返回自定义值的数据部分（从 payload[3] 开始）。
func (c *Client) CustomGet(channel, valueID byte) ([]byte, error) {
	resp, err := c.call([]byte{IDCustomGetValue, channel, valueID})
	if err != nil {
		return nil, err
	}
	if len(resp) < 4 {
		return nil, fmt.Errorf("自定义值响应过短（%d 字节）", len(resp))
	}
	return resp[3:], nil
}

func (c *Client) CustomSave() error {
	_, err := c.call([]byte{IDCustomSave})
	return err
}

func (c *Client) SetLightingValue(valueID byte, data []byte) error {
	return c.CustomSet(LightChannelRGBMatrix, valueID, data)
}

func (c *Client) GetLightingValue(valueID byte) ([]byte, error) {
	return c.CustomGet(LightChannelRGBMatrix, valueID)
}

// EncoderRaw 返回旋钮方向键的原始 4 字节（[id,layer,index] 之后）。
func (c *Client) EncoderRaw(layer, index int) ([]byte, error) {
	resp, err := c.call([]byte{IDDynamicKeymapGetEncoder, byte(layer), byte(index)})
	if err != nil {
		return nil, err
	}
	if len(resp) < 7 {
		return nil, fmt.Errorf("encoder 响应过短（%d 字节）", len(resp))
	}
	raw := make([]byte, 4)
	copy(raw, resp[3:7])
	return raw, nil
}

// EncoderConfigurable 判断固件是否允许通过 VIA 改旋钮键码。
//
// 做法：读当前值 → 写一个测试值 → 读回比对 → 立刻还原。
// 实测 AL80（YUNZII，QMK V0103）返回 true，默认值 0x00AA。
func (c *Client) EncoderConfigurable(layer int) (ok bool, cur uint16) {
	orig, err := c.GetEncoderKey(layer, 0)
	if err != nil {
		return false, 0
	}
	const probe uint16 = 0x0F0F // 不会被正常使用的键码
	if err := c.SetEncoderKey(layer, 0, probe); err != nil {
		return false, orig
	}
	after, err := c.GetEncoderKey(layer, 0)
	_ = c.SetEncoderKey(layer, 0, orig) // 无论结果如何都还原
	if err != nil {
		return false, orig
	}
	return after == probe, orig
}

// MatrixState 读取键盘原始矩阵状态（VIA id_get_keyboard_value + id_switch_matrix_state）。
//
// 返回 rows 个按位掩码：第 r 个值的第 c 位为 1 表示 (r,c) 正被按下。
// 这条命令与「当前在哪一层」无关，所以 Fn/层键也能看到。
//
// 注意偏移：QMK 里 uptime/layout_options 从 payload[2] 开始写，但矩阵状态是从
// payload[3] 开始（`command_data[i*2+3]`）。按 2 解析会整体错位一个字节，
// 表现就是「按一个键亮两个乱键」。
func (c *Client) MatrixState(rows int) ([]uint16, error) {
	resp, err := c.call([]byte{IDGetKeyboardValue, 0x03})
	if err != nil {
		return nil, err
	}
	out := make([]uint16, rows)
	for i := 0; i < rows; i++ {
		idx := 3 + i*2
		if idx+1 < len(resp) {
			out[i] = uint16(resp[idx])<<8 | uint16(resp[idx+1])
		}
	}
	return out, nil
}

// MatrixSupported 判断固件是否真的实现了矩阵状态回读：
// 用一个「按下再松开」的探测做不到，因此改为检查响应是否带上位宽（非全 0 长度）。
// 实现上依赖实际按键；这里返回 nil 表示命令本身有响应。
func (c *Client) MatrixSupported(rows int) bool {
	_, err := c.MatrixState(rows)
	return err == nil
}

// Probe 通道能力
type Probe struct {
	ProtocolVersion     int      `json:"protocolVersion"`
	LayerCount          int      `json:"layerCount"`
	MacroCount          int      `json:"macroCount"`
	EncoderConfigurable bool     `json:"encoderConfigurable"`
	EncoderCW           uint16   `json:"encoderCw"`
	EncoderCCW          uint16   `json:"encoderCcw"`
	PayloadLen          int      `json:"payloadLen"`
	Offset              int      `json:"offset"`
	Notes               []string `json:"notes"`
}

func (c *Client) DoProbe() Probe {
	p := Probe{PayloadLen: c.payloadLen, Offset: c.off}
	if v, err := c.ProtocolVersion(); err == nil {
		p.ProtocolVersion = v
	} else {
		p.Notes = append(p.Notes, "读取 VIA 协议版本失败："+err.Error())
	}
	if n, err := c.LayerCount(); err == nil && n > 0 && n <= 32 {
		p.LayerCount = n
	} else {
		p.LayerCount = 4
		p.Notes = append(p.Notes, "读取层数失败，先按 4 层显示")
	}
	if m, err := c.MacroCount(); err == nil {
		p.MacroCount = m
	}
	if ok, cur := c.EncoderConfigurable(0); ok {
		p.EncoderConfigurable = true
		p.EncoderCW, p.EncoderCCW = cur, cur
	}
	return p
}