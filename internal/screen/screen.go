// Package screen 负责屏幕通道：图片解码 → RGB565 → 分块下发。
//
// 协议已通过抓包实测确认（详见 internal/lcd）：
//   - 屏分辨率 96×160，RGB565 大端，逐行扫描
//   - 走有线设备的 HID 集合 0xFF60/0x61，report ID 0x06，每帧 65 字节
//   - 开始帧之后固件要擦除闪存，必须等约 350ms 才能发数据帧
//   - 不要在数据帧之间读回显（会打乱下发），厂商工具全程不读
package screen

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"image/png"
	_ "image/jpeg"
	"os"
	"strconv"
	"strings"
	"time"

	"al80-studio/internal/hidwin"
	"al80-studio/internal/lcd"
)

// Params 屏幕协议参数。协议已确认，以下默认值即实测值，前端一般无需改动。
type Params struct {
	Width          int    `json:"width"`       // 固定 96
	Height         int    `json:"height"`      // 固定 160
	FitMode        string `json:"fitMode"`     // contain | cover | stretch
	ByteOrder      string `json:"byteOrder"`   // 固定 be
	UsagePage      uint16 `json:"usagePage"`   // 0xFF60
	Usage          uint16 `json:"usage"`       // 0x61
	ReportSize     int    `json:"reportSize"`  // 65（含 report ID）
	HeaderTemplate string `json:"headerTemplate"` // 已废弃，保留字段兼容旧配置
	BeginTemplate  string `json:"beginTemplate"`  // 已废弃
	EndTemplate    string `json:"endTemplate"`    // 已废弃
	ChunkDelayMs   int    `json:"chunkDelayMs"`   // 数据帧间隔，默认 1ms
	Slot           int    `json:"slot"`           // 目标图片槽位（1 起），0 视为 1
	AckWaitMs      int    `json:"ackWaitMs"`      // 必须为 0：读回显会打断下发
	GapMs          int    `json:"gapMs"`          // 开始帧后等待闪存擦除，默认 350ms
	MaxBytes       int    `json:"maxBytes"`
}

type Preview struct {
	DataURL      string   `json:"dataUrl"`
	Width        int      `json:"width"`
	Height       int      `json:"height"`
	SourceWidth  int      `json:"sourceWidth"`
	SourceHeight int      `json:"sourceHeight"`
	Frames       int      `json:"frames"`
	PixelBytes   int      `json:"pixelBytes"`
	ChunkCount   int      `json:"chunkCount"`
	PayloadPer   int      `json:"payloadPerChunk"`
	HexPreview   []string `json:"hexPreview"`
	Warnings     []string `json:"warnings"`
}

type SendResult struct {
	Chunks    int      `json:"chunks"`
	Bytes     int      `json:"bytes"`
	ElapsedMs int64    `json:"elapsedMs"`
	Warnings  []string `json:"warnings"`
	HexLog    []string `json:"hexLog"`
}

// Decode 读取图片（含 GIF 帧数统计），返回原图。
func Decode(path string) (image.Image, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, fmt.Errorf("打开图片失败: %w", err)
	}
	defer f.Close()

	data := make([]byte, 0, 1<<20)
	buf := make([]byte, 64*1024)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			data = append(data, buf[:n]...)
		}
		if err != nil {
			break
		}
	}

	frames := 1
	if g, err := gif.DecodeAll(bytes.NewReader(data)); err == nil && len(g.Image) > 1 {
		frames = len(g.Image)
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, 0, fmt.Errorf("无法识别的图片格式（支持 PNG/JPG/GIF）: %w", err)
	}
	return img, frames, nil
}

// Fit 缩放并按模式定位到目标画布（黑底）。
func Fit(src image.Image, w, h int, mode string) *image.RGBA {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(dst.Pix); i += 4 {
		dst.Pix[i+3] = 255
	}
	if sw == 0 || sh == 0 {
		return dst
	}

	tw, th := w, h
	if mode != "stretch" {
		scale := float64(w) / float64(sw)
		if s := float64(h) / float64(sh); s < scale {
			scale = s
		}
		if mode == "cover" {
			scale = float64(w) / float64(sw)
			if s := float64(h) / float64(sh); s > scale {
				scale = s
			}
		}
		tw = int(float64(sw)*scale + 0.5)
		th = int(float64(sh)*scale + 0.5)
		if tw < 1 {
			tw = 1
		}
		if th < 1 {
			th = 1
		}
	}

	scaled := resizeBilinear(src, tw, th)
	offX := (w - tw) / 2
	offY := (h - th) / 2
	for y := 0; y < th; y++ {
		dy := y + offY
		if dy < 0 || dy >= h {
			continue
		}
		for x := 0; x < tw; x++ {
			dx := x + offX
			if dx < 0 || dx >= w {
				continue
			}
			r, g, bb, _ := scaled.At(x, y).RGBA()
			o := dst.PixOffset(dx, dy)
			dst.Pix[o] = uint8(r >> 8)
			dst.Pix[o+1] = uint8(g >> 8)
			dst.Pix[o+2] = uint8(bb >> 8)
			dst.Pix[o+3] = 255
		}
	}
	return dst
}

func resizeBilinear(src image.Image, w, h int) *image.RGBA {
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	sb := src.Bounds()
	sw, sh := sb.Dx(), sb.Dy()
	for y := 0; y < h; y++ {
		fy := (float64(y)+0.5)*float64(sh)/float64(h) - 0.5
		y0 := int(fy)
		if y0 < 0 {
			y0 = 0
		}
		y1 := y0 + 1
		if y1 >= sh {
			y1 = sh - 1
		}
		wy := fy - float64(y0)
		if wy < 0 {
			wy = 0
		}
		for x := 0; x < w; x++ {
			fx := (float64(x)+0.5)*float64(sw)/float64(w) - 0.5
			x0 := int(fx)
			if x0 < 0 {
				x0 = 0
			}
			x1 := x0 + 1
			if x1 >= sw {
				x1 = sw - 1
			}
			wx := fx - float64(x0)
			if wx < 0 {
				wx = 0
			}
			r00, g00, b00, _ := src.At(sb.Min.X+x0, sb.Min.Y+y0).RGBA()
			r10, g10, b10, _ := src.At(sb.Min.X+x1, sb.Min.Y+y0).RGBA()
			r01, g01, b01, _ := src.At(sb.Min.X+x0, sb.Min.Y+y1).RGBA()
			r11, g11, b11, _ := src.At(sb.Min.X+x1, sb.Min.Y+y1).RGBA()
			mix := func(a, b, c, d uint32) uint8 {
				top := float64(a)*(1-wx) + float64(b)*wx
				bot := float64(c)*(1-wx) + float64(d)*wx
				return uint8((top*(1-wy) + bot*wy) / 257)
			}
			o := dst.PixOffset(x, y)
			dst.Pix[o] = mix(r00, r10, r01, r11)
			dst.Pix[o+1] = mix(g00, g10, g01, g11)
			dst.Pix[o+2] = mix(b00, b10, b01, b11)
			dst.Pix[o+3] = 255
		}
	}
	return dst
}

// ToRGB565 把画布转成 RGB565 字节流。
func ToRGB565(img *image.RGBA, littleEndian bool) []byte {
	w := img.Bounds().Dx()
	h := img.Bounds().Dy()
	out := make([]byte, w*h*2)
	i := 0
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			o := img.PixOffset(x, y)
			r := uint16(img.Pix[o]) >> 3
			g := uint16(img.Pix[o+1]) >> 2
			b := uint16(img.Pix[o+2]) >> 3
			v := r<<11 | g<<5 | b
			if littleEndian {
				out[i] = byte(v)
				out[i+1] = byte(v >> 8)
			} else {
				out[i] = byte(v >> 8)
				out[i+1] = byte(v)
			}
			i += 2
		}
	}
	return out
}

// Quantize 把 RGB565 还原成图片，用于「所见即所得」预览。
func Quantize(raw []byte, w, h int, littleEndian bool) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	i := 0
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var v uint16
			if littleEndian {
				v = uint16(raw[i]) | uint16(raw[i+1])<<8
			} else {
				v = uint16(raw[i])<<8 | uint16(raw[i+1])
			}
			r := uint8((v >> 11) & 0x1F)
			g := uint8((v >> 5) & 0x3F)
			b := uint8(v & 0x1F)
			c := color.RGBA{
				R: r<<3 | r>>2,
				G: g<<2 | g>>4,
				B: b<<3 | b>>2,
				A: 255,
			}
			img.SetRGBA(x, y, c)
			i += 2
		}
	}
	return img
}

func pngDataURL(img image.Image) (string, error) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

// parseTemplate 解析 "92 01 {idx16} {total16}" 这样的模板。
// 支持占位符：{idx16} {idx32} {total16} {total32} {len16} {crc16} {sum}
func parseTemplate(tpl string, idx, total, chunkLen int, chunk []byte) ([]byte, error) {
	tpl = strings.TrimSpace(tpl)
	if tpl == "" {
		return nil, nil
	}
	var out []byte
	for _, tok := range strings.Fields(tpl) {
		if strings.HasPrefix(tok, "{") {
			switch strings.ToLower(strings.Trim(tok, "{}")) {
			case "idx16":
				out = append(out, byte(idx>>8), byte(idx))
			case "idx32":
				out = append(out, byte(idx>>24), byte(idx>>16), byte(idx>>8), byte(idx))
			case "total16":
				out = append(out, byte(total>>8), byte(total))
			case "total32":
				out = append(out, byte(total>>24), byte(total>>16), byte(total>>8), byte(total))
			case "len16":
				out = append(out, byte(chunkLen>>8), byte(chunkLen))
			case "crc16", "sum":
				var s uint16
				for _, b := range chunk {
					s += uint16(b)
				}
				out = append(out, byte(s>>8), byte(s))
			default:
				return nil, fmt.Errorf("未知占位符 %s", tok)
			}
			continue
		}
		v, err := strconv.ParseUint(strings.TrimPrefix(tok, "0x"), 16, 16)
		if err != nil {
			return nil, fmt.Errorf("模板中的 %q 不是合法十六进制字节", tok)
		}
		out = append(out, byte(v))
	}
	return out, nil
}

func loadPixels(path string, p Params) (*image.RGBA, int, []byte, error) {
	src, frames, err := Decode(path)
	if err != nil {
		return nil, 0, nil, err
	}
	if p.Width <= 0 || p.Height <= 0 {
		return nil, 0, nil, fmt.Errorf("屏幕尺寸无效（应为 96×160）")
	}
	canvas := Fit(src, p.Width, p.Height, p.FitMode)
	raw := ToRGB565(canvas, p.ByteOrder == "le")
	if len(raw) != lcd.TotalBytes {
		return nil, 0, nil, fmt.Errorf("像素数据 %d 字节，与屏幕要求的 %d 字节不符", len(raw), lcd.TotalBytes)
	}
	return canvas, frames, raw, nil
}

// BuildPreview 生成预览（含实际要发的字节与分包信息）。
func BuildPreview(path string, p Params) (Preview, error) {
	_, frames, raw, err := loadPixels(path, p)
	if err != nil {
		return Preview{}, err
	}
	preview := Quantize(raw, p.Width, p.Height, p.ByteOrder != "be")
	dataURL, err := pngDataURL(preview)
	if err != nil {
		return Preview{}, err
	}
	all, err := lcd.AllFrames(raw)
	if err != nil {
		return Preview{}, err
	}
	res := Preview{
		DataURL:      dataURL,
		Width:        p.Width,
		Height:       p.Height,
		SourceWidth:  preview.Bounds().Dx(),
		SourceHeight: preview.Bounds().Dy(),
		Frames:       frames,
		PixelBytes:   len(raw),
		ChunkCount:   len(all),
		PayloadPer:   lcd.Chunk,
		HexPreview:   []string{hexLine(all[0]), hexLine(all[2])},
	}
	if frames > 1 {
		res.Warnings = append(res.Warnings,
			fmt.Sprintf("源文件是 GIF（%d 帧）。动图协议尚未确认，当前只下发第一帧。", frames))
	}
	return res, nil
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func buildReport(p Params, header, data []byte, idx int) []byte {
	size := p.ReportSize
	if size <= 0 {
		size = 64
	}
	rep := make([]byte, size)
	copy(rep, header)
	copy(rep[len(header):], data)
	return rep
}

func hexLine(b []byte) string {
	var sb strings.Builder
	for i, v := range b {
		if i > 0 && i%16 == 0 {
			sb.WriteString("\n")
		}
		fmt.Fprintf(&sb, "%02X ", v)
	}
	return strings.TrimRight(sb.String(), " ")
}

// Send 按实测协议把像素数据下发到屏幕。
func Send(p Params, raw []byte, progress func(sent, total int)) (SendResult, error) {
	res := SendResult{}
	start := time.Now()

	frames, err := lcd.AllFramesSlot(raw, p.Slot)
	if err != nil {
		return res, err
	}

	infos, err := hidwin.Enumerate()
	if err != nil {
		return res, err
	}
	var target *hidwin.Info
	for i := range infos {
		// 屏幕数据走有线设备的 0xFF60/0x61 通道（report ID 0x06）
		if infos[i].VendorID == 0x28E9 && infos[i].ProductID == 0x30AF &&
			infos[i].UsagePage == 0xFF60 && infos[i].Usage == 0x61 {
			target = &infos[i]
			break
		}
	}
	if target == nil {
		return res, errNoScreenChannel(infos)
	}
	dev, err := hidwin.Open(*target)
	if err != nil {
		return res, fmt.Errorf("打开屏幕通道失败: %w", err)
	}
	defer drain(dev)
	defer dev.Close()

	gap := p.GapMs
	if gap <= 0 {
		gap = 350
	}
	delay := p.ChunkDelayMs
	if delay < 0 {
		delay = 0
	}

	for i, f := range frames {
		// 开始帧之后固件要擦除闪存，等不够整张图会丢
		if i == 1 {
			time.Sleep(time.Duration(gap) * time.Millisecond)
		}
		if err := dev.WriteRaw(f); err != nil {
			return res, fmt.Errorf("第 %d/%d 帧发送失败: %w", i+1, len(frames), err)
		}
		if delay > 0 && i >= 1 {
			time.Sleep(time.Duration(delay) * time.Millisecond)
		}
		if progress != nil && (i%16 == 0 || i == len(frames)-1) {
			progress(i+1, len(frames))
		}
	}

	res.Chunks = len(frames)
	res.Bytes = len(raw)
	res.ElapsedMs = time.Since(start).Milliseconds()
	res.HexLog = []string{hexLine(frames[0]), hexLine(frames[2])}
	return res, nil
}

// SendCommand 发送单条命令。切换显示模式等命令尚未通过抓包确认，
// 因此这里明确返回「不支持」，而不是假装发出去。
// OpenScreenDev 暴露屏幕命令通道给开发用工具。
func OpenScreenDev() (*hidwin.Device, error) { return screenDev() }

// writeFrames 逐帧写设备，单帧失败重试 3 次（USB 抖动/固件忙时偶发）。
func writeFrames(dev *hidwin.Device, frames [][]byte, gap time.Duration) error {
	for i, f := range frames {
		var err error
		for attempt := 0; attempt < 3; attempt++ {
			if err = dev.WriteRaw(f); err == nil {
				break
			}
			time.Sleep(25 * time.Millisecond)
		}
		if err != nil {
			return fmt.Errorf("第 %d/%d 帧写入失败: %w", i+1, len(frames), err)
		}
		if gap > 0 {
			time.Sleep(gap)
		}
	}
	return nil
}

// drain 把固件回显的帧读干净，免得恢复按键监听后把回显当成矩阵数据。
func drain(dev *hidwin.Device) {
	deadline := time.Now().Add(150 * time.Millisecond)
	for time.Now().Before(deadline) {
		if _, ok := dev.TryRead(20_000_000); !ok {
			return
		}
	}
}
// errNoScreenChannel 说明为什么找不到屏幕通道：2.4G 接收器实测不转发屏幕数据。
func errNoScreenChannel(infos []hidwin.Info) error {
	for _, i := range infos {
		if i.VendorID == 0x056D && i.ProductID == 0xC077 {
			return fmt.Errorf("检测到 2.4G 接收器（%s）：它只转发按键，屏幕数据发过去没有任何反应，屏幕和动图必须用数据线连接键盘", i.Product)
		}
	}
	return fmt.Errorf("没找到键盘的屏幕数据通道（0xFF60/0x61），请确认键盘已用数据线连接")
}

// screenDev 打开屏幕命令通道（有线 0xFF60/0x61，report ID 0x06）。
func screenDev() (*hidwin.Device, error) {
	infos, err := hidwin.Enumerate()
	if err != nil {
		return nil, err
	}
	for _, i := range infos {
		if i.VendorID == 0x28E9 && i.ProductID == 0x30AF &&
			i.UsagePage == 0xFF60 && i.Usage == 0x61 {
			dev, err := hidwin.Open(i)
			if err != nil {
				return nil, fmt.Errorf("打开屏幕通道失败: %w", err)
			}
			return dev, nil
		}
	}
	return nil, fmt.Errorf("没找到键盘的屏幕数据通道（0xFF60/0x61），请确认键盘已用数据线连接")
}

// AniResult 是一次动图上传的结果。
// DebugLog 由 app 注入，用于把动图上传过程写进日志。
var DebugLog func(string)

type AniResult struct {
	DeclareStatus byte `json:"declareStatus"`
	Frames    int   `json:"frames"`
	DelayMs   int   `json:"delayMs"`
	Bytes     int   `json:"bytes"`
	ElapsedMs int64 `json:"elapsedMs"`
	Skipped   int   `json:"skipped"`
}

// DecodeGIF 把动图解成逐帧画面（每帧都已合成到统一画布上，尺寸为源尺寸）。
// 第二个返回值是每帧自己的显示延迟（毫秒，来自 GIF 的 Delay 字段）。
func DecodeGIF(path string, maxFrames int) ([]image.Image, []int, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, 0, err
	}
	defer f.Close()
	g, err := gif.DecodeAll(f)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("这不是可用的 GIF: %w", err)
	}
	if len(g.Image) == 0 {
		return nil, nil, 0, fmt.Errorf("GIF 里没有画面")
	}
	w, h := g.Config.Width, g.Config.Height
	canvas := image.NewRGBA(image.Rect(0, 0, w, h))
	var out []image.Image
	var delays []int
	skipped := 0
	for i, fr := range g.Image {
		// 攒一帧：把本帧叠到画布上
		draw.Draw(canvas, fr.Bounds(), fr, fr.Bounds().Min, draw.Over)
		if i%1 == 0 {
			if maxFrames > 0 && len(out) >= maxFrames {
				skipped = len(g.Image) - len(out)
				break
			}
			cp := image.NewRGBA(canvas.Bounds())
			copy(cp.Pix, canvas.Pix)
			out = append(out, cp)
			// GIF 的 Delay 单位是 1/100 秒；逐帧保存自己的延迟
			d := 0
			if i < len(g.Delay) {
				d = g.Delay[i] * 10
			}
			delays = append(delays, d)
		}
		// 处理后帧的处置方式（只处理"恢复背景"）
		if i < len(g.Disposal) {
			switch g.Disposal[i] {
			case gif.DisposalBackground:
				b := fr.Bounds()
				draw.Draw(canvas, b, image.Transparent, image.Point{}, draw.Src)
			case gif.DisposalPrevious:
				// 简化：不回滚，实际动图里极少用
			}
		}
	}
	return out, delays, skipped, nil
}

// awaitAck 在 timeout 内等待与 frame 对应的回执（设备会把 [7] 换成状态码）。
func awaitAck(dev *hidwin.Device, frame []byte, timeout time.Duration) (byte, bool) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		raw, ok := dev.TryRead(20 * time.Millisecond)
		if !ok {
			continue
		}
		if len(raw) >= 8 && raw[1] == frame[1] && raw[2] == frame[2] &&
			raw[5] == frame[5] && raw[6] == frame[6] {
			return raw[7], true
		}
	}
	return 0, false
}

// sendCmd 发送一条命令帧并反复重试，直到设备回执状态等于 want。
// 实测：设备在擦除动图区时会用 0x0F 拒绝宣告帧，必须等它回到 0x55 再往下发，
// 否则整份动图无效（表现就是只播旧帧数/白屏）。
func sendCmd(dev *hidwin.Device, frame []byte, want byte, tries int, log func(string)) (byte, error) {
	last := byte(0)
	for i := 0; i < tries; i++ {
		for {
			if _, ok := dev.TryRead(0); !ok {
				break
			}
		}
		if err := dev.WriteRaw(frame); err != nil {
			return last, err
		}
		if st, ok := awaitAck(dev, frame, 900*time.Millisecond); ok {
			last = st
			if st == want {
				if i > 0 && log != nil {
					log(fmt.Sprintf("命令 cmd=0x%02X 第 %d 次拿到 0x55，已就绪", frame[10], i+1))
				}
				return st, nil
			}
			if log != nil {
				log(fmt.Sprintf("命令 cmd=0x%02X 状态=0x%02X 被拒，稍后重试（第 %d 次）", frame[10], st, i+1))
			}
		}
		time.Sleep(400 * time.Millisecond)
	}
	return last, fmt.Errorf("设备一直没就绪（最后状态 0x%02X）", last)
}

// SendAnimation 上传一段动图（kind = lcd.KindGifPage / lcd.KindBoot）。
func SendAnimation(p Params, frames []image.Image, delays []int, fps int, kind byte, chunkDelayMs int) (AniResult, error) {
	res := AniResult{}
	start := time.Now()
	if len(frames) == 0 {
		return res, fmt.Errorf("没有可上传的帧")
	}
	_, _ = fps, chunkDelayMs
	var logf func(string)
	if DebugLog != nil {
		logf = DebugLog
	}
	envInt := func(name string, def int) int {
		if v := os.Getenv(name); v != "" {
			if n, e := strconv.Atoi(v); e == nil {
				return n
			}
		}
		return def
	}
	delay := 120
	if len(delays) > 0 && delays[0] > 0 {
		delay = delays[0]
	}
	if delay < 20 {
		delay = 20
	}
	res.DelayMs = delay
	res.Frames = len(frames)

	dev, err := screenDev()
	if err != nil {
		return res, err
	}
	defer dev.Close()
	defer drain(dev)

	// 动图整条链路走报告 ID 0x00（静态图片才是 0x06）。
	zr := func(list [][]byte) [][]byte {
		for _, f := range list {
			if len(f) > 0 {
				f[0] = 0x00
			}
		}
		return list
	}

	// 1) 声明帧数：少这条动图页进不去
	if os.Getenv("AL80_ANI_DECLARE") != "0" {
		st, e := sendCmd(dev, zr([][]byte{lcd.AniDeclareFrame(len(frames))})[0], 0x55, 60, logf)
		if e != nil {
			return res, fmt.Errorf("声明帧数失败: %w", e)
		}
		res.DeclareStatus = st
		// 原厂"设帧数"和"上传"之间隔着几秒（界面上是两个动作）
		time.Sleep(time.Duration(envInt("AL80_ANI_DECLGAP", 0)) * time.Millisecond)
	}

	// 2) 预提交（实验）：把带帧数的"宣告+开始"放在数据之前
	if os.Getenv("AL80_ANI_PRECOMMIT") == "1" {
		for _, f := range zr(lcd.AniCommitFrames(kind, len(frames))) {
			if _, e := sendCmd(dev, f, 0x55, 30, logf); e != nil {
				return res, fmt.Errorf("预提交帧未确认: %w", e)
			}
		}
		if logf != nil {
			logf("预提交完成：数据前已创建动图页")
		}
	}

	// 3) 开场：宣告 + 开始 + 标记，逐条等到 0x55
	for _, f := range zr(lcd.AniHeadFrames(kind)) {
		if _, e := sendCmd(dev, f, 0x55, 60, logf); e != nil {
			return res, fmt.Errorf("开场帧(0x%02X)未确认: %w", f[10], e)
		}
	}
	if e := writeFrames(dev, zr([][]byte{lcd.AniStreamStart()}), 0); e != nil {
		return res, fmt.Errorf("标记帧失败: %w", e)
	}

	// 4) 逐帧（节奏完全照原厂 44 帧抓包逐帧实测）：
	//    帧头 → [块首静默 3000ms] → 40ms → 间隔头 → 15ms → 549 块数据（约 1.0ms/块）→ 40ms
	//    块首（帧号 %16 == 0）那 3 秒必须在**帧头之后、数据之前** —— 固件是靠帧头触发整块擦除的，
	//    把块首帧的数据直接塞进擦除窗口，那一帧就废了（表现：闪白 + 播放飞快）。
	blockWait := time.Duration(envInt("AL80_ANI_BLOCKWAIT", 3000)) * time.Millisecond
	chunkGap := time.Duration(envInt("AL80_ANI_CHUNKGAP", 0)) * time.Millisecond
	totalBytes := 0
	for i, fr := range frames {
		canvas := Fit(fr, p.Width, p.Height, p.FitMode)
		raw := ToRGB565(canvas, p.ByteOrder == "le")
		totalBytes += len(raw)
		if _, e := sendCmd(dev, zr([][]byte{lcd.AniPicHead(kind, i)})[0], 0x55, 60, logf); e != nil {
			return res, fmt.Errorf("第 %d 帧帧头未确认: %w", i+1, e)
		}
		if i%16 == 0 {
			time.Sleep(blockWait)
		}
		time.Sleep(40 * time.Millisecond)
		fd := delay
		if i < len(delays) && delays[i] > 0 {
			fd = delays[i]
			if fd < 20 {
				fd = 20
			}
		}
		if _, e := sendCmd(dev, zr([][]byte{lcd.AniDelayHead(fd)})[0], 0x55, 30, logf); e != nil {
			return res, fmt.Errorf("第 %d 帧间隔头未确认: %w", i+1, e)
		}
		time.Sleep(15 * time.Millisecond)
		data, e := lcd.AniDataFrames(raw)
		if e != nil {
			return res, e
		}
		if e := writeFrames(dev, data, chunkGap); e != nil {
			return res, fmt.Errorf("第 %d 帧数据传输失败: %w", i+1, e)
		}
		time.Sleep(40 * time.Millisecond)
	}
	// 5) 结束帧
	if os.Getenv("AL80_ANI_END") != "0" {
		if e := writeFrames(dev, zr([][]byte{lcd.EndFrame()}), 0); e != nil {
			return res, fmt.Errorf("结束帧失败: %w", e)
		}
	}

	// 6) 收尾：commit（默认）/ declare（实验）/ 不发
	switch {
	case os.Getenv("AL80_ANI_FINALIZE") == "declare":
		if _, e := sendCmd(dev, zr([][]byte{lcd.AniDeclareFrame(len(frames))})[0], 0x55, 30, logf); e != nil && logf != nil {
			logf(fmt.Sprintf("收尾声明帧未确认: %v", e))
		}
	case os.Getenv("AL80_ANI_COMMIT") != "0" && os.Getenv("AL80_ANI_PRECOMMIT") != "1":
		for _, f := range zr(lcd.AniCommitFrames(kind, len(frames))) {
			if _, e := sendCmd(dev, f, 0x55, 30, logf); e != nil && logf != nil {
				logf(fmt.Sprintf("提交帧未确认: %v", e))
			}
		}
	}

	// 实验：收尾之后把帧间隔头整表再补一遍（收尾会把时间表重置）
	if os.Getenv("AL80_ANI_DELAYBURST") == "1" {
		for k := 0; k < len(frames); k++ {
			if _, e := sendCmd(dev, zr([][]byte{lcd.AniDelayHead(delay)})[0], 0x55, 10, logf); e != nil {
				break
			}
		}
		if logf != nil {
			logf(fmt.Sprintf("已补发 %d 个帧间隔头(%dms)", len(frames), delay))
		}
	}
	// 7) 收尾：持续读取设备回显一段时间再断开。
	//    原厂软件一直有读线程在收回显；如果主机停读，设备回显队列塞满，它内部"落盘/标记完成"
	//    这一步就卡住，关掉句柄后动图页随即失效。
	drainMs := envInt("AL80_ANI_TAIL", 8000)
	deadline := time.Now().Add(time.Duration(drainMs) * time.Millisecond)
	got := 0
	for time.Now().Before(deadline) {
		if _, ok := dev.TryRead(50 * time.Millisecond); ok {
			got++
		}
	}
	if logf != nil {
		logf(fmt.Sprintf("收尾阶段持续读取 %dms，共收到 %d 个回显", drainMs, got))
	}

	res.Bytes = totalBytes
	res.ElapsedMs = time.Since(start).Milliseconds()
	return res, nil
}
// SetPage 切换小屏当前显示的页面。0 起，实测 1 = 第 1 张图片页。
func SetPage(index int) error {
	if index < 0 || index > 16 {
		return fmt.Errorf("页面编号要在 0~16 之间")
	}
	dev, err := screenDev()
	if err != nil {
		return err
	}
	defer dev.Close()
	frames, err := lcd.ParamFrames(0x0D, byte(index))
	if err != nil {
		return err
	}
	defer drain(dev)
	return writeFrames(dev, frames, 25*time.Millisecond)
}

// SyncClock 把电脑当前时间/日期下发给键盘（主页时钟的校准）。
func SyncClock(now time.Time) error {
	dev, err := screenDev()
	if err != nil {
		return err
	}
	defer dev.Close()
	defer drain(dev)
	if err := writeFrames(dev, [][]byte{lcd.DateFrame(now.Year(), int(now.Month()), now.Day())}, 0); err != nil {
		return err
	}
	time.Sleep(120 * time.Millisecond)
	return writeFrames(dev, [][]byte{lcd.ClockFrame(now.Hour(), now.Minute(), now.Second())}, 0)
}

// SendCommand 保留给界面用：template = "page" / "clock"。
func SendCommand(p Params, template string, arg int) error {
	switch template {
	case "page":
		return SetPage(arg)
	case "clock":
		return SyncClock(time.Now())
	default:
		return fmt.Errorf("未知的屏幕命令: %s", template)
	}
}
