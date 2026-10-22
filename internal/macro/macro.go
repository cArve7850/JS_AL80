// Package macro 负责 VIA 宏（协议 v12）的文本 ↔ 字节编解码。
//
// 固件侧（QMK quantum/dynamic_keymap.c）不做文本解析，只按操作码执行：
//
//	0x01 0xKK        tap  KK
//	0x02 0xKK        down KK（按住）
//	0x03 0xKK        up   KK（松开）
//	0x04 0xHH 0xLL   delay 小端毫秒
//
// 所以 "Hi" 要编码成 down(shift) tap(H) up(shift) tap(I)。
// 本包把用户写的文本（含 {enter}/{ctrl+c}/{delay100} 这类记号）编成操作码序列，
// 也把固件里的字节解回可读文本，保证「读出来再存回去」字节一致。
package macro

import (
	"fmt"
	"sort"
	"strings"
)

// 操作码
const (
	OpTap   = 0x01
	OpDown  = 0x02
	OpUp    = 0x03
	OpDelay = 0x04
)

// 修饰键键码
const (
	kcLCtrl  = 0x01
	kcLShift = 0x02
	kcLAlt   = 0x04
	kcLGui   = 0x08
	kcRCtrl  = 0x10
	kcRShift = 0x20
	kcRAlt   = 0x40
	kcRGui   = 0x80
)

type keyDef struct {
	code  uint16
	shift bool // 需要按住 Shift 才能打出来
}

// 命名键：{enter} / {esc} / {f1} …（大小写不敏感）
var namedKeys = map[string]keyDef{
	"enter": {0x28, false}, "return": {0x28, false}, "esc": {0x29, false}, "escape": {0x29, false},
	"bspace": {0x2A, false}, "backspace": {0x2A, false}, "tab": {0x2B, false}, "space": {0x2C, false},
	"caps": {0x39, false}, "capslock": {0x39, false}, "menu": {0x65, false}, "app": {0x65, false},
	"ins": {0x49, false}, "insert": {0x49, false}, "home": {0x4A, false}, "end": {0x4D, false},
	"pgup": {0x4B, false}, "pageup": {0x4B, false}, "pgdn": {0x4E, false}, "pagedown": {0x4E, false},
	"del": {0x4C, false}, "delete": {0x4C, false},
	"up": {0x52, false}, "down": {0x51, false}, "left": {0x50, false}, "right": {0x4F, false},
	"prtsc": {0x46, false}, "printscreen": {0x46, false}, "scrolllock": {0x47, false}, "pause": {0x48, false},
	"f1": {0x3A, false}, "f2": {0x3B, false}, "f3": {0x3C, false}, "f4": {0x3D, false},
	"f5": {0x3E, false}, "f6": {0x3F, false}, "f7": {0x40, false}, "f8": {0x41, false},
	"f9": {0x42, false}, "f10": {0x43, false}, "f11": {0x44, false}, "f12": {0x45, false},
	"minus": {0x2D, false}, "equal": {0x2E, false}, "lbracket": {0x2F, false}, "rbracket": {0x30, false},
	"backslash": {0x31, false}, "semicolon": {0x33, false}, "quote": {0x34, false}, "grave": {0x35, false},
	"comma": {0x36, false}, "period": {0x37, false}, "slash": {0x38, false},
	"mute": {0x7F, false}, "volup": {0x80, false}, "voldown": {0x81, false},
	"mplay": {0xCD, false}, "mnext": {0xB5, false}, "mprev": {0xB6, false}, "mstop": {0xB7, false},
}

// 单个可打印字符 → 键码（US 布局）
var charKeys = map[rune]keyDef{
	'a': {0x04, false}, 'b': {0x05, false}, 'c': {0x06, false}, 'd': {0x07, false}, 'e': {0x08, false},
	'f': {0x09, false}, 'g': {0x0A, false}, 'h': {0x0B, false}, 'i': {0x0C, false}, 'j': {0x0D, false},
	'k': {0x0E, false}, 'l': {0x0F, false}, 'm': {0x10, false}, 'n': {0x11, false}, 'o': {0x12, false},
	'p': {0x13, false}, 'q': {0x14, false}, 'r': {0x15, false}, 's': {0x16, false}, 't': {0x17, false},
	'u': {0x18, false}, 'v': {0x19, false}, 'w': {0x1A, false}, 'x': {0x1B, false}, 'y': {0x1C, false},
	'z': {0x1D, false},
	'1': {0x1E, false}, '2': {0x1F, false}, '3': {0x20, false}, '4': {0x21, false}, '5': {0x22, false},
	'6': {0x23, false}, '7': {0x24, false}, '8': {0x25, false}, '9': {0x26, false}, '0': {0x27, false},
	' ': {0x2C, false}, '-': {0x2D, false}, '=': {0x2E, false}, '[': {0x2F, false}, ']': {0x30, false},
	'\\': {0x31, false}, ';': {0x33, false}, '\'': {0x34, false}, '`': {0x35, false}, ',': {0x36, false},
	'.': {0x37, false}, '/': {0x38, false},
	'A': {0x04, true}, 'B': {0x05, true}, 'C': {0x06, true}, 'D': {0x07, true}, 'E': {0x08, true},
	'F': {0x09, true}, 'G': {0x0A, true}, 'H': {0x0B, true}, 'I': {0x0C, true}, 'J': {0x0D, true},
	'K': {0x0E, true}, 'L': {0x0F, true}, 'M': {0x10, true}, 'N': {0x11, true}, 'O': {0x12, true},
	'P': {0x13, true}, 'Q': {0x14, true}, 'R': {0x15, true}, 'S': {0x16, true}, 'T': {0x17, true},
	'U': {0x18, true}, 'V': {0x19, true}, 'W': {0x1A, true}, 'X': {0x1B, true}, 'Y': {0x1C, true},
	'Z': {0x1D, true},
	'!': {0x1E, true}, '@': {0x1F, true}, '#': {0x20, true}, '$': {0x21, true}, '%': {0x22, true},
	'^': {0x23, true}, '&': {0x24, true}, '*': {0x25, true}, '(': {0x26, true}, ')': {0x27, true},
	'_': {0x2D, true}, '+': {0x2E, true}, '{': {0x2F, true}, '}': {0x30, true}, '|': {0x31, true},
	':': {0x33, true}, '"': {0x34, true}, '~': {0x35, true}, '<': {0x36, true}, '>': {0x37, true},
	'?': {0x38, true},
}

var modKeys = map[string]uint16{
	"ctrl": kcLCtrl, "lctrl": kcLCtrl, "rctrl": kcRCtrl,
	"shift": kcLShift, "lshift": kcLShift, "rshift": kcRShift,
	"alt": kcLAlt, "lalt": kcLAlt, "ralt": kcRAlt,
	"gui": kcLGui, "win": kcLGui, "lwin": kcLGui, "super": kcLGui, "meta": kcLGui,
}

// Encode 把文本编码成宏字节流。支持：
//
//	普通字符（按 US 布局自动加 Shift）
//	{enter} {esc} {tab} {space} {bspace} {del} {up} {down} {left} {right} {home} {end}
//	{pgup} {pgdn} {ins} {caps} {menu} {f1}..{f12} {prtsc} {mute} {volup} {voldown} 等
//	{delay100}            停顿 100 毫秒
//	{ctrl+c} {shift+tab}  组合键（可叠加，如 {ctrl+shift+t}）
func Encode(text string) ([]byte, error) {
	var out []byte
	runes := []rune(text)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		if r != '{' {
			kd, ok := charKeys[r]
			if !ok {
				return nil, fmt.Errorf("不支持的字符 %q（特殊键请写成 {enter} 这种形式）", string(r))
			}
			out = appendTap(out, kd)
			continue
		}
		end := -1
		for j := i + 1; j < len(runes); j++ {
			if runes[j] == '}' {
				end = j
				break
			}
		}
		if end < 0 {
			return nil, fmt.Errorf("第 %d 个字符处的 { 没有对应的 }", i+1)
		}
		seg, err := encodeToken(strings.TrimSpace(string(runes[i+1 : end])))
		if err != nil {
			return nil, err
		}
		out = append(out, seg...)
		i = end
	}
	return out, nil
}

func encodeToken(token string) ([]byte, error) {
	low := strings.ToLower(token)
	if low == "" {
		return nil, fmt.Errorf("空的 {}")
	}
	if strings.HasPrefix(low, "delay") {
		ms := 0
		if _, err := fmt.Sscanf(low[5:], "%d", &ms); err != nil || ms < 0 {
			return nil, fmt.Errorf("{%s} 写法不对，应该是 {delay100}", token)
		}
		if ms > 65535 {
			ms = 65535
		}
		return []byte{OpDelay, byte(ms & 0xFF), byte(ms >> 8)}, nil
	}
	if strings.Contains(low, "+") {
		parts := strings.Split(low, "+")
		var mods []uint16
		for _, p := range parts[:len(parts)-1] {
			m, ok := modKeys[strings.TrimSpace(p)]
			if !ok {
				return nil, fmt.Errorf("{%s} 里的修饰键看不懂：%s", token, p)
			}
			mods = append(mods, m)
		}
		last := strings.TrimSpace(parts[len(parts)-1])
		kd, ok := lookupKey(last)
		if !ok {
			return nil, fmt.Errorf("{%s} 里的主键看不懂：%s", token, last)
		}
		var out []byte
		for _, m := range mods {
			out = append(out, OpDown, byte(m))
		}
		if kd.shift {
			out = append(out, OpDown, byte(kcLShift))
		}
		out = append(out, OpTap, byte(kd.code))
		if kd.shift {
			out = append(out, OpUp, byte(kcLShift))
		}
		for i := len(mods) - 1; i >= 0; i-- {
			out = append(out, OpUp, byte(mods[i]))
		}
		return out, nil
	}
	kd, ok := lookupKey(low)
	if !ok {
		return nil, fmt.Errorf("看不懂 {%s}", token)
	}
	var out []byte
	return appendTap(out, kd), nil
}

func lookupKey(s string) (keyDef, bool) {
	if kd, ok := namedKeys[s]; ok {
		return kd, true
	}
	if rs := []rune(s); len(rs) == 1 {
		kd, ok := charKeys[rs[0]]
		return kd, ok
	}
	return keyDef{}, false
}

func appendTap(out []byte, kd keyDef) []byte {
	if kd.shift {
		out = append(out, OpDown, byte(kcLShift), OpTap, byte(kd.code), OpUp, byte(kcLShift))
		return out
	}
	return append(out, OpTap, byte(kd.code))
}

// Decode 把固件字节解回可读文本：按住 Shift 时还原成大写/符号字符，
// 其它修饰键组合还原成 {ctrl+c} 这种写法，保证「读出来再存回去」字节一致。
func Decode(raw []byte) string {
	var b strings.Builder
	var held []byte // 当前按住的修饰键（按按下顺序）
	for i := 0; i < len(raw); i++ {
		op := raw[i]
		switch op {
		case 0x00:
			return b.String()
		case OpDown:
			if i+1 >= len(raw) {
				return b.String()
			}
			held = append(held, raw[i+1])
			i++
		case OpUp:
			if i+1 >= len(raw) {
				return b.String()
			}
			for k := len(held) - 1; k >= 0; k-- {
				if held[k] == raw[i+1] {
					held = append(held[:k], held[k+1:]...)
					break
				}
			}
			i++
		case OpTap:
			if i+1 >= len(raw) {
				return b.String()
			}
			code := raw[i+1]
			switch {
			case len(held) == 0:
				b.WriteString(charFor(code, false))
			case len(held) == 1 && held[0] == kcLShift:
				b.WriteString(charFor(code, true))
			default:
				names := make([]string, 0, len(held)+1)
				for _, m := range held {
					n := modName(m)
					if n == "" {
						n = fmt.Sprintf("key%02X", m)
					}
					names = append(names, n)
				}
				names = append(names, strings.Trim(charFor(code, false), "{}"))
				b.WriteString("{" + strings.Join(names, "+") + "}")
			}
			i++
		case OpDelay:
			if i+2 >= len(raw) {
				return b.String()
			}
			ms := int(raw[i+1]) | int(raw[i+2])<<8
			b.WriteString(fmt.Sprintf("{delay%d}", ms))
			i += 2
		default:
			b.WriteString(fmt.Sprintf("{?%02X}", op))
		}
	}
	return b.String()
}

// charFor 反查某个键码的可读写法；shift=true 取需要按 Shift 的字符。
func charFor(code byte, shift bool) string {
	var cands []rune
	for r, kd := range charKeys {
		if kd.code == uint16(code) && kd.shift == shift {
			cands = append(cands, r)
		}
	}
	if len(cands) > 0 {
		rank := func(r rune) int {
			switch {
			case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
				return 0
			case r >= '0' && r <= '9':
				return 1
			default:
				return 2
			}
		}
		sort.Slice(cands, func(i, j int) bool {
			if rank(cands[i]) != rank(cands[j]) {
				return rank(cands[i]) < rank(cands[j])
			}
			return cands[i] < cands[j]
		})
		return string(cands[0])
	}
	// 命名键别名可能有多个（enter/return），按名字排序保证每次结果一致
	var names []string
	for name, kd := range namedKeys {
		if kd.code == uint16(code) {
			names = append(names, name)
		}
	}
	if len(names) > 0 {
		sort.Slice(names, func(i, j int) bool {
			if len(names[i]) != len(names[j]) {
				return len(names[i]) < len(names[j])
			}
			return names[i] < names[j]
		})
		return "{" + names[0] + "}"
	}
	return fmt.Sprintf("{key%02X}", code)
}

func modName(code byte) string {
	switch code {
	case kcLCtrl:
		return "ctrl"
	case kcLShift:
		return "shift"
	case kcLAlt:
		return "alt"
	case kcLGui:
		return "gui"
	case kcRCtrl:
		return "rctrl"
	case kcRShift:
		return "rshift"
	case kcRAlt:
		return "ralt"
	case kcRGui:
		return "rgui"
	}
	return ""
}
