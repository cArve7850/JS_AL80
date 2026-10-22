// Package hidwin 用 Windows SetupAPI + HID 原生 API 枚举与读写 HID 设备。
//
// 纯 Go（syscall），不依赖 hidapi / cgo，便于单文件打包。
// 重要：句柄必须以 FILE_FLAG_OVERLAPPED 打开并全部走异步 IO。
// 否则在同步句柄上挂一个阻塞 ReadFile 后，WriteFile 会被内核串行化而永久阻塞
// （实测 AL80 上就是这种现象）。
package hidwin

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

var (
	modsetupapi = syscall.NewLazyDLL("setupapi.dll")
	modhid      = syscall.NewLazyDLL("hid.dll")
	modkernel32 = syscall.NewLazyDLL("kernel32.dll")

	procSetupDiGetClassDevsW              = modsetupapi.NewProc("SetupDiGetClassDevsW")
	procSetupDiEnumDeviceInterfaces       = modsetupapi.NewProc("SetupDiEnumDeviceInterfaces")
	procSetupDiGetDeviceInterfaceDetailW  = modsetupapi.NewProc("SetupDiGetDeviceInterfaceDetailW")
	procSetupDiDestroyDeviceInfoList      = modsetupapi.NewProc("SetupDiDestroyDeviceInfoList")
	procSetupDiGetDeviceRegistryPropertyW = modsetupapi.NewProc("SetupDiGetDeviceRegistryPropertyW")

	procHidDGetAttributes         = modhid.NewProc("HidD_GetAttributes")
	procHidDGetPreparsedData      = modhid.NewProc("HidD_GetPreparsedData")
	procHidDFreePreparsedData     = modhid.NewProc("HidD_FreePreparsedData")
	procHidPGetCaps               = modhid.NewProc("HidP_GetCaps")
	procHidDGetProductString      = modhid.NewProc("HidD_GetProductString")
	procHidDGetManufacturerString = modhid.NewProc("HidD_GetManufacturerString")
	procHidDGetSerialNumberString = modhid.NewProc("HidD_GetSerialNumberString")
	procHidDSetNumInputBuffers    = modhid.NewProc("HidD_SetNumInputBuffers")

	procCancelIoEx          = modkernel32.NewProc("CancelIoEx")
	procGetOverlappedResult = modkernel32.NewProc("GetOverlappedResult")
	procCreateEventW        = modkernel32.NewProc("CreateEventW")
	procResetEvent          = modkernel32.NewProc("ResetEvent")
	procWaitForSingleObject = modkernel32.NewProc("WaitForSingleObject")
)

func createEvent() (syscall.Handle, error) {
	r, _, err := procCreateEventW.Call(0, 1, 0, 0) // 手动复位事件
	if r == 0 {
		return 0, err
	}
	return syscall.Handle(r), nil
}

func resetEvent(h syscall.Handle) { procResetEvent.Call(uintptr(h)) }

func waitSingle(h syscall.Handle, ms uint32) uint32 {
	r, _, _ := procWaitForSingleObject.Call(uintptr(h), uintptr(ms))
	return uint32(r)
}

const (
	digcfPresent         = 0x00000002
	digcfDeviceInterface = 0x00000010
	genericRead          = 0x80000000
	genericWrite         = 0x40000000
	fileShareRead        = 0x00000001
	fileShareWrite       = 0x00000002
	openExisting         = 3
	fileFlagOverlapped   = 0x40000000
	spdrpDeviceDesc      = 0x00000000
	spdrpMfg             = 0x0000000B
	spdrpFriendlyName    = 0x0000000C
	spdrpEnumeratorName  = 0x00000016
	errorNoMoreItems     = 259
	waitTimeout          = 0x00000102
	waitInfinite         = 0xFFFFFFFF
)

// GUID 对应 {4d1e55b2-f16f-11cf-88cb-001111000030}（HID 设备接口类）
var hidGUID = GUID{
	Data1: 0x4d1e55b2,
	Data2: 0xf16f,
	Data3: 0x11cf,
	Data4: [8]byte{0x88, 0xcb, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30},
}

type GUID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

type spDeviceInterfaceData struct {
	CbSize             uint32
	InterfaceClassGuid GUID
	Flags              uint32
	Reserved           uintptr
}

type spDevInfoData struct {
	CbSize    uint32
	ClassGuid GUID
	DevInst   uint32
	Reserved  uintptr
}

type hiddAttributes struct {
	Size          uint32
	VendorID      uint16
	ProductID     uint16
	VersionNumber uint16
}

type hidpCaps struct {
	Usage                     uint16
	UsagePage                 uint16
	InputReportByteLength     uint16
	OutputReportByteLength    uint16
	FeatureReportByteLength   uint16
	Reserved                  [17]uint16
	NumberLinkCollectionNodes uint32
	NumberInputButtonCaps     uint32
	NumberInputValueCaps      uint32
	NumberInputDataIndices    uint32
	NumberOutputButtonCaps    uint32
	NumberOutputValueCaps     uint32
	NumberOutputDataIndices   uint32
	NumberFeatureButtonCaps   uint32
	NumberFeatureValueCaps    uint32
	NumberFeatureDataIndices  uint32
}

// Info 一个 HID 接口（collection）的描述
type Info struct {
	Path             string `json:"path"`
	VendorID         uint16 `json:"vendorId"`
	ProductID        uint16 `json:"productId"`
	VersionNumber    uint16 `json:"versionNumber"`
	UsagePage        uint16 `json:"usagePage"`
	Usage            uint16 `json:"usage"`
	InReportLength   int    `json:"inReportLength"`
	OutReportLength  int    `json:"outReportLength"`
	FeatureReportLen int    `json:"featureReportLength"`
	Product          string `json:"product"`
	Manufacturer     string `json:"manufacturer"`
	Serial           string `json:"serial"`
	Enumerator       string `json:"enumerator"`
	DeviceDesc       string `json:"deviceDesc"`
	OpenError        string `json:"openError,omitempty"`
}

func (i Info) UsageString() string {
	return fmt.Sprintf("0x%04X/0x%02X", i.UsagePage, i.Usage)
}

func (i Info) VIDPIDSring() string {
	return fmt.Sprintf("0x%04X:0x%04X", i.VendorID, i.ProductID)
}

// Enumerate 返回系统中所有 HID collection。
func Enumerate() ([]Info, error) {
	h, _, err := procSetupDiGetClassDevsW.Call(
		uintptr(unsafe.Pointer(&hidGUID)), 0, 0,
		uintptr(digcfPresent|digcfDeviceInterface))
	if h == uintptr(syscall.InvalidHandle) || h == 0 {
		return nil, fmt.Errorf("SetupDiGetClassDevs 失败: %v", err)
	}
	defer procSetupDiDestroyDeviceInfoList.Call(h)

	var out []Info
	for index := uint32(0); ; index++ {
		did := spDeviceInterfaceData{CbSize: uint32(unsafe.Sizeof(spDeviceInterfaceData{}))}
		r, _, callErr := procSetupDiEnumDeviceInterfaces.Call(
			h, 0, uintptr(unsafe.Pointer(&hidGUID)), uintptr(index), uintptr(unsafe.Pointer(&did)))
		if r == 0 {
			if errno, ok := callErr.(syscall.Errno); ok && errno == errorNoMoreItems {
				break
			}
			break
		}

		var reqSize uint32
		procSetupDiGetDeviceInterfaceDetailW.Call(h, uintptr(unsafe.Pointer(&did)), 0, 0,
			uintptr(unsafe.Pointer(&reqSize)), 0)
		if reqSize == 0 {
			continue
		}
		buf := make([]byte, reqSize)
		*(*uint32)(unsafe.Pointer(&buf[0])) = 8 // sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W) on x64
		devInfo := spDevInfoData{CbSize: uint32(unsafe.Sizeof(spDevInfoData{}))}
		r, _, _ = procSetupDiGetDeviceInterfaceDetailW.Call(h, uintptr(unsafe.Pointer(&did)),
			uintptr(unsafe.Pointer(&buf[0])), uintptr(reqSize), 0, uintptr(unsafe.Pointer(&devInfo)))
		if r == 0 {
			continue
		}
		path := syscall.UTF16ToString((*[512]uint16)(unsafe.Pointer(&buf[4]))[:])
		if path == "" {
			continue
		}
		info := inspect(path)
		info.Enumerator = registryString(h, &devInfo, spdrpEnumeratorName)
		info.DeviceDesc = registryString(h, &devInfo, spdrpDeviceDesc)
		out = append(out, info)
	}
	return out, nil
}

func registryString(set uintptr, devInfo *spDevInfoData, prop uint32) string {
	buf := make([]byte, 512)
	var needed uint32
	r, _, _ := procSetupDiGetDeviceRegistryPropertyW.Call(set, uintptr(unsafe.Pointer(devInfo)),
		uintptr(prop), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), uintptr(unsafe.Pointer(&needed)))
	if r == 0 {
		return ""
	}
	return syscall.UTF16ToString((*[256]uint16)(unsafe.Pointer(&buf[0]))[:])
}

// inspect 打开设备路径，读取 VID/PID、usage page/usage 与报告长度。
func inspect(path string) Info {
	info := Info{Path: path}
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		info.OpenError = err.Error()
		return info
	}
	h, err := syscall.CreateFile(p, genericRead|genericWrite, fileShareRead|fileShareWrite,
		nil, openExisting, 0, 0)
	if err != nil {
		info.OpenError = err.Error()
		return info
	}
	defer syscall.CloseHandle(h)

	var attrs hiddAttributes
	attrs.Size = uint32(unsafe.Sizeof(attrs))
	if r, _, _ := procHidDGetAttributes.Call(uintptr(h), uintptr(unsafe.Pointer(&attrs))); r != 0 {
		info.VendorID = attrs.VendorID
		info.ProductID = attrs.ProductID
		info.VersionNumber = attrs.VersionNumber
	}

	var pp uintptr
	if r, _, _ := procHidDGetPreparsedData.Call(uintptr(h), uintptr(unsafe.Pointer(&pp))); r != 0 && pp != 0 {
		var caps hidpCaps
		if r2, _, _ := procHidPGetCaps.Call(pp, uintptr(unsafe.Pointer(&caps))); r2 != 0 {
			info.UsagePage = caps.UsagePage
			info.Usage = caps.Usage
			info.InReportLength = int(caps.InputReportByteLength)
			info.OutReportLength = int(caps.OutputReportByteLength)
			info.FeatureReportLen = int(caps.FeatureReportByteLength)
		}
		procHidDFreePreparsedData.Call(pp)
	}

	info.Product = hidString(h, procHidDGetProductString)
	info.Manufacturer = hidString(h, procHidDGetManufacturerString)
	info.Serial = hidString(h, procHidDGetSerialNumberString)
	return info
}

func hidString(h syscall.Handle, proc *syscall.LazyProc) string {
	buf := make([]uint16, 256)
	r, _, _ := proc.Call(uintptr(h), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)*2))
	if r == 0 {
		return ""
	}
	return strings.TrimSpace(syscall.UTF16ToString(buf))
}

var (
	// ErrWriteTimeout 写入超时：通道不接收数据。
	ErrWriteTimeout = errors.New("写入超时（设备未接收该通道数据）")
	// ErrClosed 设备已关闭。
	ErrClosed = errors.New("设备已关闭")
)

// Device 一个已打开、可用于收发的 HID 接口（异步 IO）。
type Device struct {
	Info Info

	h       syscall.Handle
	inLen   int
	outLen  int
	readEv  syscall.Handle
	writeEv syscall.Handle

	writeMu    sync.Mutex
	writeStuck int32

	inbox   chan []byte
	closing chan struct{}
	once    sync.Once
}

// Open 打开指定路径的 HID 接口并启动读线程。
func Open(info Info) (*Device, error) {
	p, err := syscall.UTF16PtrFromString(info.Path)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(p, genericRead|genericWrite, fileShareRead|fileShareWrite,
		nil, openExisting, fileFlagOverlapped, 0)
	if err != nil {
		return nil, fmt.Errorf("打开设备失败: %w", err)
	}
	readEv, err := createEvent()
	if err != nil {
		syscall.CloseHandle(h)
		return nil, err
	}
	writeEv, err := createEvent()
	if err != nil {
		syscall.CloseHandle(readEv)
		syscall.CloseHandle(h)
		return nil, err
	}

	d := &Device{
		Info:    info,
		h:       h,
		inLen:   info.InReportLength,
		outLen:  info.OutReportLength,
		readEv:  readEv,
		writeEv: writeEv,
		inbox:   make(chan []byte, 128),
		closing: make(chan struct{}),
	}
	if d.inLen <= 0 {
		d.inLen = 64
	}
	if d.outLen <= 0 {
		d.outLen = 64
	}
	procHidDSetNumInputBuffers.Call(uintptr(h), 64)
	go d.readLoop()
	return d, nil
}

func (d *Device) Device() Info        { return d.Info }
func (d *Device) Handle() syscall.Handle { return d.h }

// readOnce 异步读一条报告，无限等待（Close 时由 CancelIoEx 打断）。
func (d *Device) readOnce(buf []byte) (int, error) {
	resetEvent(d.readEv)
	ov := &syscall.Overlapped{HEvent: d.readEv}
	n := uint32(0)
	err := syscall.ReadFile(d.h, buf, &n, ov)
	if err == nil {
		runtime.KeepAlive(buf)
		return int(n), nil
	}
	if err != syscall.ERROR_IO_PENDING {
		return 0, err
	}
	r1 := waitSingle(d.readEv, waitInfinite)
	if r1 == waitTimeout {
		return 0, errors.New("读取超时")
	}
	var done uint32
	if r2, _, rerr := procGetOverlappedResult.Call(uintptr(d.h), uintptr(unsafe.Pointer(ov)),
		uintptr(unsafe.Pointer(&done)), 1); r2 == 0 {
		return 0, rerr
	}
	runtime.KeepAlive(buf)
	return int(done), nil
}

func (d *Device) readLoop() {
	buf := make([]byte, d.inLen)
	for {
		select {
		case <-d.closing:
			return
		default:
		}
		n, err := d.readOnce(buf)
		if err != nil {
			return
		}
		if n == 0 {
			continue
		}
		payload := make([]byte, n)
		copy(payload, buf[:n])
		select {
		case d.inbox <- payload:
		default:
			select {
			case <-d.inbox:
			default:
			}
			select {
			case d.inbox <- payload:
			default:
			}
		}
	}
}

// writeLocked 异步发送，超时返回 ErrWriteTimeout。
func (d *Device) writeLocked(buf []byte, timeout time.Duration) error {
	size := d.outLen
	if size < len(buf) {
		size = len(buf)
	}
	out := make([]byte, size)
	copy(out, buf)

	resetEvent(d.writeEv)
	ov := &syscall.Overlapped{HEvent: d.writeEv}
	n := uint32(0)
	err := syscall.WriteFile(d.h, out, &n, ov)
	if err == nil {
		runtime.KeepAlive(out)
		return nil
	}
	if err != syscall.ERROR_IO_PENDING {
		return fmt.Errorf("写入失败: %w", err)
	}
	ms := uint32(timeout / time.Millisecond)
	if ms == 0 {
		ms = 1000
	}
	r1 := waitSingle(d.writeEv, ms)
	if r1 == waitTimeout {
		procCancelIoEx.Call(uintptr(d.h), uintptr(unsafe.Pointer(ov)))
		return ErrWriteTimeout
	}
	var done uint32
	if r2, _, rerr := procGetOverlappedResult.Call(uintptr(d.h), uintptr(unsafe.Pointer(ov)),
		uintptr(unsafe.Pointer(&done)), 1); r2 == 0 {
		return fmt.Errorf("写入失败: %w", rerr)
	}
	runtime.KeepAlive(out)
	return nil
}

// WriteRaw 发送任意长度缓冲，长度不足 outLen 时右侧补 0。
func (d *Device) WriteRaw(buf []byte) error {
	return d.WriteRawTimeout(buf, 2*time.Second)
}

// WriteRawTimeout 带超时的写入；通道一旦卡住，后续写入立即失败。
func (d *Device) WriteRawTimeout(buf []byte, timeout time.Duration) error {
	if atomic.LoadInt32(&d.writeStuck) != 0 {
		return ErrWriteTimeout
	}
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	err := d.writeLocked(buf, timeout)
	if errors.Is(err, ErrWriteTimeout) {
		atomic.StoreInt32(&d.writeStuck, 1)
	}
	return err
}

// Write 发送 VIA 报告（右侧对齐，兼容 report ID 前缀）。
func (d *Device) Write(payload []byte) error {
	size := d.outLen
	if size < len(payload) {
		size = len(payload)
	}
	buf := make([]byte, size)
	if size >= len(payload) {
		copy(buf[size-len(payload):], payload)
	} else {
		copy(buf, payload)
	}
	return d.WriteRawTimeout(buf, 900*time.Millisecond)
}

// Drain 清空未读的输入报告。
func (d *Device) Drain() {
	for {
		select {
		case <-d.inbox:
		default:
			return
		}
	}
}

// Request 写入 payload 并等待一条输入报告。
func (d *Device) Request(payload []byte, timeout time.Duration) ([]byte, error) {
	d.Drain()
	if err := d.Write(payload); err != nil {
		return nil, err
	}
	resp, ok := d.TryRead(timeout)
	if !ok {
		return nil, errors.New("等待设备响应超时")
	}
	return resp, nil
}

// TryRead 在 timeout 内尝试读一条输入报告。
func (d *Device) TryRead(timeout time.Duration) ([]byte, bool) {
	if timeout <= 0 {
		select {
		case raw := <-d.inbox:
			return raw, true
		default:
			return nil, false
		}
	}
	select {
	case raw := <-d.inbox:
		return raw, true
	case <-time.After(timeout):
		return nil, false
	case <-d.closing:
		return nil, false
	}
}

// IsWriteStuck 该通道是否已确认不可写。
func (d *Device) IsWriteStuck() bool { return atomic.LoadInt32(&d.writeStuck) != 0 }

// Close 关闭设备。
func (d *Device) Close() {
	d.once.Do(func() {
		close(d.closing)
		procCancelIoEx.Call(uintptr(d.h), 0)
		syscall.CloseHandle(d.readEv)
		syscall.CloseHandle(d.writeEv)
		syscall.CloseHandle(d.h)
	})
}
