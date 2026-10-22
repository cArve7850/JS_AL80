package hidwin

import "testing"

// 冒烟测试：枚举本机 HID，确认 SetupAPI + HidP_GetCaps 调用链可用。
func TestEnumerate(t *testing.T) {
	list, err := Enumerate()
	if err != nil {
		t.Fatalf("Enumerate 失败: %v", err)
	}
	t.Logf("发现 %d 个 HID collection", len(list))
	if len(list) == 0 {
		t.Fatal("一个 HID 设备都没枚举到，说明调用链有问题")
	}
	shown := 0
	for _, d := range list {
		if shown >= 8 {
			break
		}
		shown++
		t.Logf("%s usage=%s IN=%d OUT=%d product=%q enum=%q err=%q",
			d.VIDPIDSring(), d.UsageString(), d.InReportLength, d.OutReportLength,
			d.Product, d.Enumerator, d.OpenError)
	}
}
