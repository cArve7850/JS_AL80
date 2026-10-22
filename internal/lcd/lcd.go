// Package lcd 实现 AL80 键盘小屏的私有协议（抓包实测得出，非猜测）。
//
// 传输通道：2.4G 接收器（VID 0x056D / PID 0xC077）上的 HID 集合 0xFF87/usage 0x20，
// 输出报告 64 字节，写入时必须带 report ID 0x06，即每次写 65 字节。
//
// 帧格式（65 字节）：
//
//	[0]     0x06        report ID
//	[1]     opcode      0x40=开始  0x41=数据  0x42=结束
//	[2..3]  offset      LE uint16（数据帧的字节偏移）
//	[4]     length      本帧数据长度（56，末帧不足 56）
//	[5..6]  checksum    LE uint16 = (sum(bytes[1..4]) + sum(data)) mod 65536
//	[7]     0x00        保留
//	[8..]   data        数据
//	[64]    tail        数据帧 0x69 / 结束帧 0x55
//
// 一次完整的上传 = 开始帧 + 图片头帧 + 549 个数据帧（30720 字节）+ 结束帧。
// 像素格式：RGB565，大端，共 30720 字节 = 15360 像素。
package lcd

import (
	"fmt"
)

const (
	// ReportID 是写入时必须置于首字节的报告 ID。
	ReportID = 0x06
	// FrameSize 是每一帧的总长度（含 report ID）。
	FrameSize = 65
	// Chunk 是每个数据帧承载的字节数。
	Chunk = 56
	// TotalBytes 是一整屏像素数据的字节数。
	TotalBytes = 30720

	OpStart byte = 0x40
	OpData  byte = 0x41
	OpEnd   byte = 0x42

	tailData byte = 0x69
	tailEnd  byte = 0x55
)

// 两个头部载荷是抓包实测的固定值（工具每次上传都一样）。
var (
	// startPayload 来自 0x40 帧，8 字节。
	startPayload = []byte{0xA5, 0x5A, 0x10, 0x00, 0x01, 0xC5, 0xB1, 0x01}
	// picHeaderPayload 来自第一个 0x41 帧，7 字节。
	picHeaderPayload = []byte{0xA5, 0x5A, 0x0C, 0x78, 0x00, 0xC3, 0x93}
)

func checksum(op byte, offset int, data []byte) uint16 {
	sum := int(op) + offset&0xFF + (offset>>8)&0xFF + len(data)
	for _, b := range data {
		sum += int(b)
	}
	return uint16(sum & 0xFFFF)
}

// AniStatus 是动图通道帧的第 7 字节。实测这个字节是**设备自己填的状态位**：
// 不管我发 0x00 还是 0x55，回显都是 0x55（静态图片通道同样被改成 0x55），
// 所以发送方填 0x00 即可。
const AniStatus byte = 0x00

// build 组装一帧（第 7 字节固定 0，静态图片通道用）。
func build(op byte, offset int, data []byte, tail byte) []byte {
	return buildB7(op, offset, data, tail, 0x00)
}

// buildB7 同 build，可指定第 7 字节（动图通道用 AniStatus）。
func buildB7(op byte, offset int, data []byte, tail byte, b7 byte) []byte {
	f := make([]byte, FrameSize)
	f[0] = ReportID
	f[1] = op
	f[2] = byte(offset & 0xFF)
	f[3] = byte((offset >> 8) & 0xFF)
	f[4] = byte(len(data))
	cs := checksum(op, offset, data)
	f[5] = byte(cs & 0xFF)
	f[6] = byte((cs >> 8) & 0xFF)
	f[7] = b7
	copy(f[8:], data)
	f[FrameSize-1] = tail
	return f
}

// 命令层：厂商工具除了传图，还会发"内部命令"帧，格式是
//   0x40 帧，数据区前 7 字节 = A5 5A <cmd> 00 <len> <csum16>，
//   命令的参数依次放在这 7 字节之后（或紧随的 0x41 帧里）。
// 以下两条是抓包实测并与时间戳对上号的：
//   cmd 0x09 = 对时，参数 [时, 分, 秒]（十进制，非 BCD）
//   cmd 0x0A = 对日期，参数 [年高位, 年低位, 月, 日]，例：2026-10-22 → 20 26 10 22
var (
	cmdTimeHeader = []byte{0xA5, 0x5A, 0x09, 0x00, 0x03, 0xC3, 0xE1}
	cmdDateHeader = []byte{0xA5, 0x5A, 0x0A, 0x00, 0x04, 0x01, 0x50}
)

// 单参数命令：cmd 0x0B / 0x0D / 0x0F 的结构是
//   0x40（内部头 A5 5A cmd 00 01 <csum16>）→ 0x41（1 字节参数）→ 0x42 结束
// 抓包只录到了 0x40 和 0x42，参数帧被固件回显队列吞掉了，所以参数语义待验证。
var cmdParamHeaders = map[byte][]byte{
	0x0B: {0xA5, 0x5A, 0x0B, 0x00, 0x01, 0xC2, 0xC1},
	0x0D: {0xA5, 0x5A, 0x0D, 0x00, 0x01, 0xC3, 0x21},
	0x0F: {0xA5, 0x5A, 0x0F, 0x00, 0x01, 0x03, 0x80},
}

// 动图（GIF）协议：抓包实测，厂商工具传一张 84 帧的动图时是这么发的——
//
//	0x12 [kind 00]   宣告：kind 1 = 动图页，0 = 开机动画
//	0x13 [kind 00]   开始传输
//	每帧：0x41(off=0,len=10) A5 5A 10 00 03 0430 02 <kind> <序号>
//	      0x41(off=0,len=7)  A5 5A 11 <间隔lo> <间隔hi> 03C5     ← 0x0078 = 120ms
//	      然后 549 个像素帧（0..30688，每帧 56 字节）覆盖整帧 30720 字节
//	最后 0x42 结束
//
// 内部头 A5 5A cmd ... 的校验字节只覆盖前 5 字节，所以每帧都是固定值。
var (
	aniAnnounce = []byte{0xA5, 0x5A, 0x12, 0x00, 0x02, 0x04, 0x50, 0x00, 0x00}
	aniBegin    = []byte{0xA5, 0x5A, 0x13, 0x00, 0x02, 0xC4, 0x01, 0x00, 0x00}
	aniPicHead  = []byte{0xA5, 0x5A, 0x10, 0x00, 0x03, 0x04, 0x30, 0x02, 0x00, 0x00}
	aniDelay    = []byte{0xA5, 0x5A, 0x11, 0x78, 0x00, 0xC5, 0x03}
)

// KindGifPage 是动图页，KindBoot 是开机动画。
const (
	KindGifPage byte = 1
	KindBoot    byte = 0
)

// AniHeadFrames 返回"宣告 + 开始传输"两帧。
func AniHeadFrames(kind byte) [][]byte {
	a := append([]byte{}, aniAnnounce...)
	a[7] = kind
	b := append([]byte{}, aniBegin...)
	b[7] = kind
	return [][]byte{
		buildB7(OpStart, 0, a, aniTailCmd, AniStatus),
		buildB7(OpStart, 0, b, aniTailCmd, AniStatus),
	}
}

// 动图路径的帧尾：抓包实测同一会话内按帧类型固定，会话之间随机变化
// （见过的值：0x8a / 0x95 / 0x6d），换用别的值固件照样回 0x55 状态，说明不参与校验。
// 这里统一用一个固定值。
const (
	aniTailCmd    = 0x6d // 0x40 命令帧（宣告/开始）
	aniTailMark   = 0x6d // 0x40 标记帧
	aniTail       = 0x6d // 0x41 帧头与像素帧
	aniTailCommit = 0x55 // 提交帧
)

// AniDeclareFrame 返回"声明帧数"帧：0x40 A5 5A 13 00 02 C401 [00][帧数]。
// 抓包实测原厂在正式开始上传之前会先单独发一条，把这份动图的帧数告诉固件。
func AniDeclareFrame(count int) []byte {
	b := append([]byte{}, aniBegin...)
	b[7] = 0x00
	b[8] = byte(count & 0xFF)
	return buildB7(OpStart, 0, b, aniTailCommit, AniStatus)
}

// AniStreamStart 返回像素流之前的标记帧（抓包里是 7 字节全 0 的 0x40 帧）。
func AniStreamStart() []byte {
	return buildB7(OpStart, 0, make([]byte, 7), aniTailMark, AniStatus)
}

// AniDataFrames 把一帧画面切成动图路径的数据帧（帧尾 0x6d）。
func AniDataFrames(pixels []byte) ([][]byte, error) {
	if len(pixels) != TotalBytes {
		return nil, fmt.Errorf("像素数据必须是 %d 字节，实际 %d 字节", TotalBytes, len(pixels))
	}
	var out [][]byte
	for off := 0; off < TotalBytes; off += Chunk {
		end := off + Chunk
		if end > TotalBytes {
			end = TotalBytes
		}
		out = append(out, buildB7(OpData, off, pixels[off:end], aniTail, AniStatus))
	}
	return out, nil
}
// AniCommitFrames 返回上传结束后的提交帧。
// 抓包里每次动图/开机动画传完都紧跟一对 0x12[01 1c] / 0x13[01 18]；
// 少了它固件不认这份动图，动图页会变成"没有内容"而无法切入。
func AniCommitFrames(kind byte, frames int) [][]byte {
	a := append([]byte{}, aniAnnounce...)
	a[7] = kind
	a[8] = 0x00 // 抓包：原厂这两帧的最后一个字节恒为 0，填帧数反而会重置帧时间表
	b := append([]byte{}, aniBegin...)
	b[7] = kind
	b[8] = 0x00
	_ = frames
	return [][]byte{buildB7(OpStart, 0, a, aniTailCommit, AniStatus), buildB7(OpStart, 0, b, aniTailCommit, AniStatus)}
}
// AniPicHead 返回某一帧画面的帧头（kind + 帧序号）。
func AniPicHead(kind byte, index int) []byte {
	h := append([]byte{}, aniPicHead...)
	h[8] = kind
	h[9] = byte(index & 0xFF)
	return buildB7(OpData, 0, h, aniTail, AniStatus)
}

// AniDelayHead 返回帧间隔头（毫秒，抓包恒为 120）。
// 注意：第一帧的这个头必须等固件擦完闪存再发（实测厂商工具等了 3 秒）。
func AniDelayHead(delayMs int) []byte {
	d := append([]byte{}, aniDelay...)
	d[3] = byte(delayMs & 0xFF)
	d[4] = byte((delayMs >> 8) & 0xFF)
	return buildB7(OpData, 0, d, aniTail, AniStatus)
}

// AniFrameHeads 返回某一帧画面的两个头（帧序号 + 帧间隔毫秒）。
func AniFrameHeads(kind byte, index int, delayMs int) [][]byte {
	return [][]byte{AniPicHead(kind, index), AniDelayHead(delayMs)}
}
// ParamFrames 返回一条单参数命令的三帧（开始 / 参数 / 结束）。
func ParamFrames(cmd byte, value byte) ([][]byte, error) {
	h, ok := cmdParamHeaders[cmd]
	if !ok {
		return nil, fmt.Errorf("未知命令 0x%02X", cmd)
	}
	return [][]byte{
		build(OpStart, 0, h, 0x55),
		build(OpData, 0, []byte{value}, 0x69),
		build(OpEnd, 0, make([]byte, Chunk), 0x55),
	}, nil
}
// ClockFrame 返回对时帧（时/分/秒）。
func ClockFrame(hour, minute, second int) []byte {
	data := append(append([]byte{}, cmdTimeHeader...), byte(hour), byte(minute), byte(second))
	return build(OpStart, 0, data, 0x55)
}

// DateFrame 返回对日期帧（年 2000 起拆成两个字节）。
func DateFrame(year, month, day int) []byte {
	data := append(append([]byte{}, cmdDateHeader...), byte(year/100), byte(year%100), byte(month), byte(day))
	return build(OpStart, 0, data, 0x55)
}
// StartFrame 返回上传开始帧。
func StartFrame() []byte { return StartFrameSlot(0x01) }

// StartFrameSlot 返回开始帧，最后一个字节是**目标槽位号**（1 起）。
// 抓包里这张固定是 0x01，也就是我之前所有图片都覆盖了第 1 页的原因。
func StartFrameSlot(slot byte) []byte {
	p := append([]byte{}, startPayload...)
	p[7] = slot
	return build(OpStart, 0, p, tailFor(false))
}

// PicHeaderFrame 返回图片头帧（在开始帧之后立即发送）。
func PicHeaderFrame() []byte { return build(OpData, 0, picHeaderPayload, tailFor(false)) }

// EndFrame 返回上传结束帧。
func EndFrame() []byte { return build(OpEnd, 0, make([]byte, Chunk), tailFor(true)) }

// TailOverride 允许把帧尾字节改成实测得到的值（默认 0x69/0x55）。
// 帧尾是每次上传会话随机的标记，某些固件会校验它，所以保留可调。
var TailOverride = [2]byte{}

func tailFor(isEnd bool) byte {
	if isEnd {
		if TailOverride[1] != 0 {
			return TailOverride[1]
		}
		return tailEnd
	}
	if TailOverride[0] != 0 {
		return TailOverride[0]
	}
	return tailData
}

// DataFrames 把整屏像素数据切成帧。pixels 必须是 30720 字节。
func DataFrames(pixels []byte) ([][]byte, error) {
	if len(pixels) != TotalBytes {
		return nil, fmt.Errorf("像素数据必须是 %d 字节，实际 %d 字节", TotalBytes, len(pixels))
	}
	var out [][]byte
	for off := 0; off < TotalBytes; off += Chunk {
		end := off + Chunk
		if end > TotalBytes {
			end = TotalBytes
		}
		out = append(out, build(OpData, off, pixels[off:end], tailFor(false)))
	}
	return out, nil
}

// AllFrames 返回一次完整上传的全部帧（含开始/图片头/数据/结束）。
func AllFrames(pixels []byte) ([][]byte, error) {
	return AllFramesSlot(pixels, 1)
}

// AllFramesSlot 同 AllFrames，但可以指定目标槽位（1 起）。
func AllFramesSlot(pixels []byte, slot int) ([][]byte, error) {
	data, err := DataFrames(pixels)
	if err != nil {
		return nil, err
	}
	if slot < 1 || slot > 255 {
		slot = 1
	}
	out := make([][]byte, 0, len(data)+3)
	out = append(out, StartFrameSlot(byte(slot)))
	out = append(out, PicHeaderFrame())
	out = append(out, data...)
	out = append(out, EndFrame())
	return out, nil
}
