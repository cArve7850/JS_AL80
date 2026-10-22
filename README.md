# AL80 Studio

YUNZII AL80（QMK / VIA 固件 V0103）的 Windows 桌面控制软件。免驱动、免安装、单文件运行。

改键位、调灯效、传屏幕图片与动图、编辑宏，全部在一个窗口里完成。

> **非官方项目**：本软件由个人开发者为自己购买的键盘编写，与 YUNZII 及其关联公司无关，未获其授权或背书。文中出现的产品名称与固件版号仅用于说明兼容性。请勿将本项目的图标、名称用于暗示官方身份。

> **AI 辅助声明**：本项目由人类提出需求、定义行为并做真机验证，代码（Go 后端与 React 前端）主要由 AI（大语言模型）辅助编写与重构。所有硬件协议均来自实机抓包与实测，未使用未经验证的猜测性实现。详见「开发方式」。

---

## 功能

| 模块 | 能力 |
| --- | --- |
| 按键设置 | 4 层键位读取与改写；3D / 2D 双视图点选改键；选键二级菜单（分类 + 搜索）；旋钮顺时针 / 逆时针 / 按下分别绑定；整层复制粘贴；实时按键高亮、按键延迟（ms）与 APM |
| 灯光设置 | 25 种 RGB 矩阵灯效；亮度 / 速度；HSV 色盘 + 明度 + 屏幕吸管 + HEX 输入；改动实时下发 |
| 屏幕设置 | 96×160 小屏静态图片上传；GIF 动图上传；内置预览与量化预览；切页、对时 |
| 键盘宏 | 宏录制与下发（基于 VIA 宏通道） |
| 通用 | 配置导入导出；设备自检；诊断信息；连接状态与矩阵掩码显示 |

界面为中文，灯效副标题保留固件原始英文名，便于对照厂商文档。

---

## 运行

1. 下载 `release/AL80 Studio.exe`。
2. 双击运行（不需要安装，不需要驱动）。
3. 用**数据线**连接键盘（USB 有线模式）。

要求：Windows 10 / 11 x64。Windows 11 自带 WebView2 运行时；Windows 10 若提示缺少 WebView2，安装微软官方 Evergreen Runtime 即可。

软件不联网、不上传任何数据、不写注册表。日志写在 `%TEMP%\al80-studio.log`，仅用于排错，可随时删除。

---

## 已知限制（实测得出，非推测）

- **2.4G 与蓝牙不能用于配置。** 键盘的配置协议（VIA）只存在于 USB 有线通道（HID 集合 `0xFF60/0x61`）。
  - 2.4G 接收器（`056D:C077`）暴露两条厂商通道，只接受报告 ID `0x06` / `0x0A` 的私有帧；实测发送 VIA 握手始终无应答，推整屏屏幕数据也无反应，接收器只转发按键。
  - 蓝牙 HID 规范不含厂商自定义通道，固件也未实现 BLE 透传。
- **屏幕与动图必须插数据线**，原因同上。
- 亮度读回可能有 ±1 的量化误差，属固件行为。
- 灯效「全熄」下固件会忽略亮度与颜色，这是正常现象（界面会提示）。
- 本软件不修改、不刷写键盘固件。

---

## 直接使用（推荐）

仓库里的 `release/AL80 Studio.exe` 就是编译好的程序，双击即可运行，不需要装 Go、Node 或任何运行库（Windows 11 自带 WebView2；Windows 10 若提示缺失，装微软官方 Evergreen Runtime）。

## 从源码编译（不需要联网下载依赖）

仓库里已经打包了两样东西，所以**不用** `npm install`、也**不用**拉 Go 依赖：

- `vendor/` —— 全部 Go 依赖（`go mod vendor` 的产物，Go 1.21+ 会自动使用它，无需设置 GOFLAGS）
- `frontend/dist/` —— 已经构建好的前端产物

所以编译只需要两样工具（属编译器本身，无法打包进仓库）：

- Go 1.21+（开发使用 1.25）
- Wails CLI v2：`go install github.com/wailsapp/wails/v2/cmd/wails@latest`

然后一条命令（Windows PowerShell，复制即可用）：

```powershell
git clone https://github.com/cArve7850/JS_AL80.git
cd JS_AL80
wails build -platform windows/amd64 -webview2 browser -trimpath -s
```

`-s` 表示跳过前端构建、直接用仓库里的 `frontend/dist`；`-trimpath` 表示不把本机绝对路径写进 exe。

产物在 `build/bin/al80-studio.exe`，改名为 `AL80 Studio.exe` 即可分发。

验证过的离线编译（断网状态）：

```powershell
$env:GOPROXY="off"      # 断网模拟：禁止任何模块下载
wails build -platform windows/amd64 -webview2 browser -trimpath -s
```

### 想改前端界面

`frontend/dist` 是预先构建的产物。要改 React 源码才需要 Node.js 18+：

```powershell
cd frontend
npm install
npm run build     # 或开发模式：npm run dev
cd ..
wails build -platform windows/amd64 -webview2 browser -trimpath -s
```

### 其它命令

- 开发模式（热重载）：`wails dev`
- 只做静态检查：`cd frontend && npx tsc --noEmit`、`go build ./...`

---

## 目录结构

```
.
├── app.go                   # Wails 绑定层：把设备能力暴露给前端
├── main.go                  # 程序入口与窗口配置
├── internal/
│   ├── device/              # 设备管理器：连接、键位、灯光、旋钮、矩阵轮询
│   ├── via/                 # VIA 协议实现（HID 报文封装与编解码）
│   ├── hidwin/              # Windows HID 访问（SetupAPI + hid.dll，纯 Go）
│   ├── lcd/                 # 小屏私有协议（静态图片、动图、对时）
│   ├── screen/              # 图片/动图处理：缩放、RGB565 转换、分块下发
│   └── macro/               # 宏序列编码
├── frontend/
│   ├── public/draco/        # DRACO 解码器（3D 键帽网格用）
│   └── src/
│       ├── pages/           # 四个功能模块页面
│       ├── components/      # 3D 键盘模型、2D 面板、取色器、选键器、状态栏
│       ├── config/          # 配列、灯效表、屏幕参数
│       └── lib/             # Wails 桥接、状态存储、颜色换算、键码表
├── build/                   # 图标与 Windows 清单
└── release/                 # 编译好的单文件 exe
```

---

## 安全与隐私

- 不含网络请求、遥测、账号体系或自动更新。
- 不含密钥、令牌、个人信息或本机路径（exe 已用 `-trimpath` 构建并逐字节校验过）。
- HID 访问只针对目标键盘的 VID/PID，不枚举、不写入其它设备。
- 日志只写时间戳与协议层调试信息，不记录用户输入内容。

---

## 第三方组件与许可证

本项目以 **GPL-3.0** 发布，因为三维视图移植自 VIA 官方前端并包含其素材。详见 [NOTICE](NOTICE)。

- 3D 键帽网格 `frontend/src/assets/via-keycaps.glb`：来自 the-via/app（GPL-3.0）
- 3D 实现思路（外壳剖面、选件规则、UV 公式、材质光照）：移植自 the-via/app（GPL-3.0）
- three.js（MIT）、Google Draco（Apache-2.0）、React（MIT）、Wails v2（MIT）

---

## 开发方式（AI 辅助）

- 需求、交互与验收标准由人类提出；所有硬件协议（VIA 报文、屏幕帧格式、动图协议）通过在真机上抓包与反复试错确认，结论都写在对应源码的注释里，包括走过的弯路与错误结论。
- 代码主要由 AI 辅助生成，人类负责编译、真机验证与反馈修正。
- 标注「实测」的行为均为真机验证结果；未验证的部分在注释里写明「待验证」，不假装已实现。

欢迎 Issue 与 PR。修改硬件协议相关代码时，请附上抓包证据或实测结论。

## 许可证

GNU General Public License v3.0，见 [LICENSE](LICENSE)。