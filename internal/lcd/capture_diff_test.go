package lcd

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"os"
	"regexp"
	"testing"
)

var writeRe = regexp.MustCompile(`WRITE h=0x([0-9A-F]+) len=(\d+) ([0-9A-F]+)`)

// TestCaptureMatchesBuilder 校验：用抓包数据重建的帧是否与我这边生成的帧逐字节相同。
// 跑法：设置 AL80_TRACE 指向抓包日志，then go test ./internal/lcd -run Capture -v
func TestCaptureMatchesBuilder(t *testing.T) {
	path := os.Getenv("AL80_TRACE")
	if path == "" {
		t.Skip("未设置 AL80_TRACE，跳过")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	var captured [][]byte
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		m := writeRe.FindStringSubmatch(sc.Text())
		if m == nil {
			continue
		}
		b, err := hex.DecodeString(m[3])
		if err != nil || len(b) != FrameSize {
			continue
		}
		captured = append(captured, b)
	}
	if len(captured) > 552 {
		captured = captured[:552]
	}
	t.Logf("抓包帧数: %d", len(captured))

	pixels := make([]byte, TotalBytes)
	for _, b := range captured {
		if b[1] != OpData || (int(b[4]) != Chunk && int(b[4]) != 32) {
			continue
		}
		off := int(b[2]) | int(b[3])<<8
		copy(pixels[off:], b[8:8+int(b[4])])
	}
	mine, err := AllFrames(pixels)
	if err != nil {
		t.Fatal(err)
	}
	if len(mine) != len(captured) {
		t.Fatalf("帧数不一致：抓包 %d，我生成 %d", len(captured), len(mine))
	}
	diff := 0
	for i := range captured {
		if !bytes.Equal(captured[i], mine[i]) {
			diff++
			if diff <= 3 {
				t.Errorf("第 %d 帧不同\n  抓包 %X\n  我的 %X", i, captured[i], mine[i])
			}
		}
	}
	if diff == 0 {
		t.Logf("全部 %d 帧逐字节一致", len(captured))
	}
}
