/**
 * AL80 三维视图
 *
 * 几何与做法照 usevia.app 的 3D 实现移植（the-via/app, GPL-3.0）：
 *   · 键帽网格：assets/via-keycaps.glb（VIA 官方 keyboard_components.glb，DRACO 压缩）
 *     按排号 R1/R2/R3/R4/R4C + 宽度选件，1u = 19.15mm（case.tsx / key-group.tsx 的规则）
 *   · 每颗键生成平面 UV（update-uv-maps.ts 的公式），底色 + 字符画进画布贴图
 *     （unit-key/keycap.tsx 的 paintKeycap），文字因此长在键帽顶面上，不再是浮动平面
 *   · 外壳是楔形托盘：侧剖面梯形、前薄后厚 7.5°、外圈主题色 + 内衬深色、1mm 倒角（case.tsx）
 *   · 材质 MeshPhongMaterial（shininess/specular），光照 ambient + 聚光灯 + 双点光，
 *     另有一块同色地面承接阴影（canvas-router.tsx）
 * 单位：1u = 19.15mm。可拖动旋转，点击键帽回调 (row, col)。
 */
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { AL80_LAYOUT, KNOB, LAYOUT_WIDTH_UNITS, MATRIX_ROWS } from '../config/keymap.layout'
import { getScreenImage, onScreenImage, setScreenImage } from '../lib/screenStore'
import keycapGlbUrl from '../assets/via-keycaps.glb?url'

/* ---------------- 尺寸（毫米，照 VIA） ---------------- */
const PITCH_MM = 19.15
const CAP_MM = 18.16
const MM = 1 / PITCH_MM // 毫米 → u

/* ---------------- 外壳尺寸：YUNZII AL80 真机 314.45 × 137.7 × 41.1mm ---------------- */
const PROPER_W_MM = LAYOUT_WIDTH_UNITS * PITCH_MM - 1.05 // 键区宽 305.35
const PROPER_H_MM = MATRIX_ROWS * PITCH_MM - 1.05 // 键区深 113.85
const CASE_W_MM = 314.45 // 真机总宽
const CASE_D_MM = 137.7 // 真机总深 → 前后各 11.9mm 边框（左右只有 4.55mm）
const CASE_FRONT_MM = 10.5 // 前面高度
const CASE_TOP_MM = CASE_FRONT_MM + Math.tan((7.5 * Math.PI) / 180) * (CASE_D_MM - 2) // 后面 ≈28.4
const PLATE_INSET_MM = 1.5 // 键区外露的深色开关板宽度
const BEZEL_MM = 1
const CASE_Z_MM = -1 // 内衬/开关板顶面相对键帽底平面下沉 1mm

/* ---------------- VIA UV 公式常数（update-uv-maps.ts） ---------------- */
const SIZE_1U = 1 / 2.6
const UV_UNIT = 19.05
const UV_CORNER = 0.445
const HOVER_LIFT_MM = 8 // keycap.tsx: zUp = maxZ + 8
// F 排和下面几排之间的空隙实测 4mm；键帽本身已经占了 (19.15-18.44)=0.71mm，
// 所以要把 F 排整体再往后推 3.29mm
const CAP_GAP_MM = 1.05 // VIA 的 KeycapMetric.keyXSpacing：格距 19.15 - 键帽 18.1
const ROW0_EXTRA_MM = 4 - (PITCH_MM - (PITCH_MM - CAP_GAP_MM))
const KNOB_DIA_MM = 18 // 真机金属旋钮直径（用户实测）
const KNOB_H_MM = 12.5 // 旋钮露出高度（官网总高 41.1 − 机身后面 28.6）
const PRESS_DIP_MM = 1.5 // 按下时键帽下沉量（视觉反馈）

const ROW_PROFILE = ['R1', 'R1', 'R2', 'R3', 'R4', 'R4C'] // 6 排映射到 VIA 的 5 种排型
// 键帽组的纵向偏移（key-group.tsx 的 (19.15*height - 1.05)/2）
const GROUP_Y_GLOBAL = (PITCH_MM * MATRIX_ROWS - 1.05) / 2

// ---- 键帽三色（照实机配色，按键位 id 固定，改键也不会变色）----
// 黑：Esc、空格、回车、四个方向键
const BLACK_KEYS = new Set([
  '0,0', // Esc
  '3,13', // ⏎ 回车
  '5,6', // ␣ 空格
  '4,13', '5,12', '5,13', '5,14', // ↑ ← ↓ →
])
// 深米黄：F5–F8、Del、退格、PgUp、PgDn、Tab、CapsLock、左右 Shift、左右 Ctrl、Win、Alt、Fn
const TAN_KEYS = new Set([
  '0,5', '0,6', '0,7', '0,8', // F5–F8
  '0,13', // ⌦ Del
  '1,13', // ⌫ 退格
  '1,14', // PgUp
  '2,0', // ⇥ Tab
  '2,14', // PgDn
  '3,0', // ⇪ CapsLock
  '4,0', '4,12', // 左 / 右 Shift
  '5,0', '5,11', // 左 / 右 Ctrl
  '5,1', // ⊞ Win
  '5,2', // Alt
  '5,10', // Fn
])

/* ---------------- 配色（AL80 金属阳极氧化银机身 + 白/灰白/黑三色键帽） ---------------- */
const COL_CASE = '#c6c9cd' // 外壳：阳极氧化银
const COL_CASE_IN = '#a7abb1' // 内衬/底盘：同一块铝，暗一档，让键缝看得出来
const COL_FLOOR = '#23262c'
const COL_CAP = '#f7f5f0' // 白色（其余所有键）
const COL_CAP_GREY = '#c4c1ba' // 灰白
const COL_CAP_DIRTY = '#8fb9ff'
const COL_CAP_PRESSED = '#66d9a3'
const COL_CAP_DARK = '#1b1512' // 黑（Esc/空格/回车/方向键）
const COL_LEGEND_LIGHT = '#f2ebde'
const COL_LEGEND = '#3a352d'
const COL_LEGEND_DIRTY = '#0e2a4d'
const COL_KNOB = '#c2c6ca' // 旋钮：同样是阳极氧化银
const COL_SPEC_CASE = '#7f858c' // 金属高光色

export interface KbModelProps {
  labels: Record<string, string>
  dirty: Set<string>
  pressed: Set<string>
  onPick?: (row: number, col: number) => void
  resetKey?: number
  /** 不在前台时暂停渲染（省 GPU，切回来不用重建场景） */
  paused?: boolean
}

interface CapEntry {
  mesh: THREE.Mesh
  baseY: number
  kind: 'alpha' | 'mod'
  canvas: HTMLCanvasElement
  tex: THREE.CanvasTexture
  wU: number
  dU: number
  hoverT: number
  pressT: number
  lastPaint: string
}

interface SceneApi {
  applyLabels?: (l: Record<string, string>) => void
  applyStates?: (d?: Set<string>, p?: Set<string>) => void
  reset?: () => void
}

/* ---------------- 形状工具 ---------------- */

/**
 * 外壳侧剖面 —— 照 case.tsx 的 makeShape2 原样：
 * x = 厚度（前 10mm → 后 10 + tan7.5°×深度），y = 机身深度，四角半径 2mm。
 * 顶面是平的（x≈0 那侧），斜的是底面，所以键帽全在同一高度上。
 */
function makeShape2(layoutHeight: number, bottomWidth = 10, radius = 2): THREE.Shape {
  const offsetXMultiplier = Math.tan((Math.PI * 7.5) / 180)
  const topWidth = bottomWidth + offsetXMultiplier * layoutHeight
  const halfY = layoutHeight / 2
  const path = new THREE.Shape()
  const baseAngle = Math.PI / 2
  path.moveTo(-topWidth, halfY)
  path.absarc(-topWidth - radius, halfY - radius, radius, baseAngle * 2, baseAngle * 1, true)
  path.absarc(-radius, halfY, radius, baseAngle * 1, 0, true)
  path.absarc(-radius, -halfY, radius, baseAngle * 4, baseAngle * 3, true)
  path.absarc(-bottomWidth - radius, -halfY - radius, radius, baseAngle * 3, baseAngle * 2, true)
  return path
}

/** 几何体的坐标映射：VIA 的 (x, y, z) → 本工程的 (x, z, −y)（VIA 的 +Z 朝上、+Y 朝后） */
function viaToWorld(geo: THREE.BufferGeometry) {
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 1, 0), // e_x → +y
    new THREE.Vector3(0, 0, -1), // e_y → −z
    new THREE.Vector3(-1, 0, 0), // e_z → −x
  )
  geo.applyMatrix4(m)
  geo.scale(MM, MM, MM)
}

/** 照 case.tsx 造一块外壳（剖面包住、沿宽度方向挤出、带倒角） */
function buildCaseMesh(
  layoutHeightMm: number,
  depthMm: number,
  bevelSizeMm: number,
  bevelThicknessMm: number,
  color: string,
  shininess: number,
  specular: string,
  posYMm: number,
  posXMm = 0,
  bottomWidthMm = 10,
  radiusMm = 2,
): THREE.Mesh {
  const shape = makeShape2(layoutHeightMm, bottomWidthMm, radiusMm)
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: depthMm,
    bevelEnabled: true,
    bevelSize: bevelSizeMm,
    bevelThickness: bevelThicknessMm,
    bevelSegments: 10,
    curveSegments: 12,
  })
  viaToWorld(geo)
  // 归一化：X 居中、顶面落到 y=0、Z 居中，调用方只需要给"顶面高度"
  geo.computeBoundingBox()
  {
    const bb = geo.boundingBox!
    geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.max.y, -(bb.min.z + bb.max.z) / 2)
  }
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshPhongMaterial({
      color: new THREE.Color(color),
      shininess,
      reflectivity: 0.35,
      specular: new THREE.Color(specular),
    }),
  )
  mesh.position.set(posXMm * MM, posYMm * MM, 0) // posYMm = 顶面高度
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

/** 照 update-uv-maps.ts：平面投影 UV（机身坐标已转成 Y-up，故取 x / z） */
function applyPlanarUV(geo: THREE.BufferGeometry) {
  const pos = geo.attributes.position as THREE.BufferAttribute
  geo.computeBoundingBox()
  const bb = geo.boundingBox!
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    // VIA 的公式以毫米为单位，此处顶点已缩成 u，先换回毫米
    const xMm = (pos.getX(i) - bb.min.x) * PITCH_MM + UV_CORNER
    const zMm = (bb.max.z - pos.getZ(i)) * PITCH_MM + UV_CORNER
    uv[2 * i] = (SIZE_1U * xMm) / UV_UNIT
    uv[2 * i + 1] = (SIZE_1U * zMm) / UV_UNIT
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
}

/** 照 keycap.tsx 的 calculateTextureRects：键帽矩形 + 顶面矩形（UV 空间） */
function calculateTextureRects(wU: number, dU: number) {
  const gap = (UV_CORNER / UV_UNIT) * SIZE_1U
  const kw = Math.min(2.75, wU)
  const kd = Math.min(2.75, dU)
  const keycapRect = {
    bl: { x: gap, y: gap },
    tr: { x: kw * SIZE_1U - gap, y: kd * SIZE_1U - gap },
  }
  const faceRect = {
    bl: { x: keycapRect.bl.x + 0.07, y: keycapRect.bl.y + 0.08 },
    tr: { x: keycapRect.tr.x - 0.07, y: keycapRect.tr.y - 0.0146 },
  }
  return { keycapRect, faceRect }
}

/**
 * 照 keycap.tsx 的 paintKeycap / paintKeycapLabel：
 * 512×倍数的画布刷底色，字符用 75px 粗体画在顶面矩形的左上角（真键帽的排版），并裁掉溢出面外的部分。
 */
function paintCap(
  canvas: HTMLCanvasElement,
  wU: number,
  dU: number,
  bg: string,
  fg: string,
  text: string,
) {
  const canvasSize = 512
  const wm = Math.max(1, wU)
  const dm = Math.max(1, dU)
  canvas.width = Math.round(canvasSize * wm)
  canvas.height = Math.round(canvasSize * dm)
  const g = canvas.getContext('2d')!
  g.fillStyle = bg
  g.fillRect(0, 0, canvas.width, canvas.height)
  if (!text) return
  const { faceRect } = calculateTextureRects(wU, dU)
  const margin = { x: 0.015, y: 0.02 }
  const singleLabelMargin = { x: 0.01, y: 0.02 }
  g.beginPath()
  g.moveTo(faceRect.bl.x * canvas.width, (1 - faceRect.bl.y) * canvas.height)
  g.lineTo(faceRect.bl.x * canvas.width, (1 - faceRect.tr.y) * canvas.height)
  g.lineTo(faceRect.tr.x * canvas.width, (1 - faceRect.tr.y) * canvas.height)
  g.lineTo(faceRect.tr.x * canvas.width, (1 - faceRect.bl.y) * canvas.height)
  g.closePath()
  g.clip()
  g.fillStyle = fg
  g.textAlign = 'left'
  g.textBaseline = 'alphabetic'
  let fontSize = 75
  const fontFamily = 'Fira Sans, "Segoe UI", "Microsoft YaHei", Arial'
  const fits = () => {
    g.font = `bold ${fontSize}px ${fontFamily}`
    return (
      g.measureText(text).width <=
      (faceRect.tr.x - (faceRect.bl.x + singleLabelMargin.x)) * canvas.width
    )
  }
  while (fontSize > 18 && !fits()) fontSize -= 4
  g.font = `bold ${fontSize}px ${fontFamily}`
  const fontHeightTU = (0.75 * fontSize) / canvas.height
  g.fillText(
    text,
    (faceRect.bl.x + singleLabelMargin.x) * canvas.width,
    (1 - (faceRect.tr.y - fontHeightTU - singleLabelMargin.y - margin.y * 0)) * canvas.height,
  )
}
export default function KbModel({ labels, dirty, pressed, onPick, resetKey, paused }: KbModelProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<SceneApi>({})
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const stateRef = useRef({ labels, dirty, pressed })
  stateRef.current = { labels, dirty, pressed }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let dead = false
    const disposers: Array<() => void> = []
    // 开发自检开关（Wails 绑定返回 Promise，必须异步取值，否则永远为真）
    let allowShot = false
    {
      const api0 = (
        window as unknown as { go?: { main?: { App?: { WantShot?: () => Promise<boolean> | boolean } } } }
      ).go?.main?.App
      if (api0?.WantShot) {
        Promise.resolve(api0.WantShot())
          .then((v) => {
            allowShot = !!v
          })
          .catch(() => {
            allowShot = false
          })
      }
    }

    const scene = new THREE.Scene()
    // 照 VIA：fov 25 + zoom 4.4 等效 ≈5.8° 长焦近正交，相机正对机身顶面
    // 这里直接用小 fov 拉到远处，效果相同（透视压缩感一致）
    const CAM_FOV = 8.6
    const CAM_DIST = 62
    const TILT_DEG = 8.6 // VIA 悬停时的整板倾角，作为默认视角
    const camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 1, 400)
    camera.up.set(0, 0, -1) // 屏幕上方 = 机身后方，和 VIA 的朝向一致
    const TR = (TILT_DEG * Math.PI) / 180
    const ZERO = new THREE.Vector3(0, 0, 0)

    // 自己算球面机位：pitch = 偏离正上方（朝观察者）的角度，yaw = 左右摆动
    // 目标角（拖动直接改）+ 当前角（弹簧跟随，VIA 的 react-spring 手感）
    let yaw = 0
    let pitch = TR
    let yawCur = 0
    let pitchCur = TR
    let yawVel = 0
    let pitchVel = 0
    const SPRING_TENSION = 130 // 刚度
    const SPRING_FRICTION = 17 // 阻尼：越大越"黏"，越小越飘
    const PITCH_MIN = 0.02
    const PITCH_MAX = 0.62 // ≈35°，比 VIA 的 ±18° 放宽
    const YAW_LIM = 0.38 // ≈22°，比 VIA 的 ±11° 放宽
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
    const placeCamera = () => {
      const sp = Math.sin(pitchCur)
      const cp = Math.cos(pitchCur)
      camera.position.set(CAM_DIST * sp * Math.sin(yawCur), CAM_DIST * cp, CAM_DIST * sp * Math.cos(yawCur))
      camera.lookAt(ZERO)
    }
    placeCamera()

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.NoToneMapping // 同 VIA 的 <Canvas flat>
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    host.appendChild(renderer.domElement)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'

    // 拖动旋转由下面自己处理（照 VIA 的 ±18°/±11° 范围 + 松手回弹）

    // ---- 灯光 ----
    scene.add(new THREE.AmbientLight(0xffffff, 1.08))
    const spot = new THREE.SpotLight(0xffffff, 92, 0, Math.PI / 5, 0.5, 1.05)
    spot.position.set(0, 34, 7)
    spot.castShadow = true
    spot.shadow.mapSize.set(2048, 2048)
    spot.shadow.camera.near = 12
    spot.shadow.camera.far = 56
    // 大块平面上最容易出现阴影摩尔纹（旋转时看着像"底盘发花"），
    // 用 normalBias 顶掉、再把 bias 收小，避免阴影飘离物体
    spot.shadow.bias = -0.00025
    spot.shadow.normalBias = 0.04
    spot.shadow.radius = 2
    spot.target.position.set(0, 0, 0)
    scene.add(spot)
    scene.add(spot.target)
    const rimA = new THREE.PointLight(0xdfe8f6, 4.5, 0, 1.3)
    rimA.position.set(-8, 1.6, 6)
    scene.add(rimA)
    const rimB = new THREE.PointLight(0xfff2dd, 4.5, 0, 1.3)
    rimB.position.set(8, 1.6, 6)
    scene.add(rimB)

    // ---- 地面（同色，接阴影） ----
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(140, 140),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(COL_FLOOR), roughness: 1 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -2.2
    floor.receiveShadow = true
    scene.add(floor)

    // ---- 外壳：AL80 真机尺寸的铝合金托盘 + 深色开关板 ----
    // 顶面平（键帽底平面下方 1mm），底面斜 7.5°：前 10.5mm、后 ≈28.4mm
    const shell = buildCaseMesh(
      // 剖面 y 方向会被四段圆弧外扩 3×半径，这里预先扣掉，保证总深正好 137.7
      CASE_D_MM - 3 * 4 - BEZEL_MM * 2,
      CASE_W_MM - BEZEL_MM * 2, // 挤出长度 = 总宽 − 两侧倒角
      BEZEL_MM,
      BEZEL_MM,
      COL_CASE,
      70, // 阳极氧化铝：高光比塑料强
      COL_SPEC_CASE,
      CASE_Z_MM, // 顶面落在这里
      0,
      CASE_FRONT_MM - 2 * 4 - BEZEL_MM * 2, // 前面厚度正好 10.5mm
      4,
    )
    scene.add(shell)

    // 开关板：只在键区范围内，露出 1.5mm 深色边 + 键缝；顶面与外壳顶面齐平
    {
      const pw = PROPER_W_MM + PLATE_INSET_MM * 2
      const pd = PROPER_H_MM + PLATE_INSET_MM * 2 + ROW0_EXTRA_MM
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(pw * MM, 3 * MM, pd * MM),
        new THREE.MeshPhongMaterial({
          color: new THREE.Color(COL_CASE_IN),
          shininess: 55,
          reflectivity: 0.45,
          specular: new THREE.Color(COL_SPEC_CASE),
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        }),
      )
      // 顶面比外壳顶面高 0.12mm，避免和外壳共面打架（旋转视角时底盘的"花"）
      // 深度多了 ROW0_EXTRA_MM，整体往后挪一半，保持和键区同心
      plate.position.set(0, CASE_Z_MM * MM + 0.12 * MM - 1.5 * MM, (-ROW0_EXTRA_MM / 2) * MM)
      plate.receiveShadow = true
      scene.add(plate)
    }

    // ---- 小屏幕：第 15 列、第 3–4 排（右方向键正上方、PgDn 下面），竖屏 96×160 ----
    const drawIdleScreen = (g: CanvasRenderingContext2D, cw: number, ch: number) => {
      g.fillStyle = '#05080b'
      g.fillRect(0, 0, cw, ch)
      g.fillStyle = '#0e3f52'
      g.fillRect(0, 0, cw, 4)
      g.fillRect(0, ch - 4, cw, 4)
      g.fillRect(0, 0, 4, ch)
      g.fillRect(cw - 4, 0, 4, ch)
      g.fillStyle = '#4fd0ea'
      g.font = '700 26px "Segoe UI", sans-serif'
      g.textAlign = 'center'
      g.fillText('AL80', cw / 2, 60)
      g.fillStyle = '#1d6a82'
      g.font = '600 13px "Segoe UI", sans-serif'
      g.fillText('无图', cw / 2, 86)
      g.fillStyle = '#123642'
      g.fillRect(12, 110, cw - 24, 8)
      g.fillStyle = '#2fa8cc'
      g.fillRect(12, 110, (cw - 24) * 0.35, 8)
    }

    const scrState = {
      tex: null as THREE.CanvasTexture | null,
      mesh: null as THREE.Mesh | null,
      baseY: 0,
      zoom: 1, // 当前放大倍数（悬停 / 刚上图时放大，方便看清内容）
      hover: false,
      boostUntil: 0,
    }
    {
      const cw = 96
      const ch = 160
      const c = document.createElement('canvas')
      c.width = cw
      c.height = ch
      const sg = c.getContext('2d')!
      drawIdleScreen(sg, cw, ch)
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      // 0.85" 96×160 面板：18.5 × 31mm，占满第 3–4 排那一格宽度
      const scrGeo = new THREE.PlaneGeometry(18.5 * MM, 31 * MM)
      scrGeo.rotateX(-Math.PI / 2)
      const scr = new THREE.Mesh(
        scrGeo,
        new THREE.MeshBasicMaterial({
          map: tex,
          toneMapped: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      )
      const sx = (15.5 * PITCH_MM - PROPER_W_MM / 2) * MM
      // 竖跨第 3、4 排的中心（第 5 排就是右方向键）
      const sz = ((3.5 * PITCH_MM + 4.5 * PITCH_MM) / 2 - GROUP_Y_GLOBAL) * MM
      scr.position.set(sx, CASE_Z_MM * MM + 0.3 * MM, sz)
      scene.add(scr)
      scrState.mesh = scr
      scrState.baseY = scr.position.y

      // 实时镜像「屏幕」页的画面：预览一变就重画这张贴图
      const img = new Image()
      const repaintScreen = (dataUrl: string | null) => {
        const dbgS = (window as unknown as { go?: { main?: { App?: { DebugLog?: (s: string) => void } } } }).go
        dbgS?.main?.App?.DebugLog?.(
          dataUrl ? 'SCREEN 镜像已更新 len=' + dataUrl.length : 'SCREEN 清空（无图）',
        )
        if (!dataUrl) {
          drawIdleScreen(sg, cw, ch)
          tex.needsUpdate = true
          return
        }
        img.onload = () => {
          sg.fillStyle = '#000'
          sg.fillRect(0, 0, cw, ch)
          sg.drawImage(img, 0, 0, cw, ch)
          tex.needsUpdate = true
          // 刚换上图，自动放大 1.6 秒，避免 45×73px 看不清
          scrState.boostUntil = performance.now() + 1600
        }
        img.src = dataUrl
      }
      repaintScreen(getScreenImage())
      const offScreen = onScreenImage(repaintScreen)
      disposers.push(offScreen)
    }
    // ---- 键帽（坐标照 key-group.tsx 的 getPosition + 组偏移） ----
    let knobDims = { dia: 0, height: 0 }
    let fGapMm = 0 // F 排组间横向缝（键帽边缘之间）
    let fGapEdge = 0
    let row0Front = 0
    let bottomEdge = 0
    const rawCaps: { name: string; rawWMm: number; rawDMm: number }[] = []
    const bottomGaps: number[] = []
    const bottomDbg: { id: string; mesh?: string; wMm: number; cxMm: number }[] = []
    let rowGapMm = 0 // F 排和下面一排之间的纵向缝（键帽边缘之间）
    const caps = new Map<string, CapEntry>()
    const pickables: THREE.Mesh[] = []
    const capGeos = new Map<string, THREE.BufferGeometry>()

    const GROUP_X = (-LAYOUT_WIDTH_UNITS * PITCH_MM + 1.05) / 2
    const GROUP_Y = (PITCH_MM * MATRIX_ROWS - CAP_GAP_MM) / 2
    const capPos = (x: number, y: number, w: number, h: number): [number, number] => {
      // 用真正的格心：(x + w/2) 个格距。VIA 原来拿"半个键帽宽(9.22)"当推进量，
      // 1u 的键只差 0.35mm 看不出来，但 6.25u 的空格会整体偏左 2.2mm，
      // 于是空格右边和 Fn 之间多出一条缝（你反馈的那处）。
      const xMm = PITCH_MM * (x + w / 2) + GROUP_X
      // 第 0 排（F 排）额外往后推 ROW0_EXTRA_MM，让 F 排和下一排之间的缝是 4mm
      const rowExtra = y === 0 ? ROW0_EXTRA_MM : 0
      const yMm = -(PITCH_MM * (y + h / 2)) + GROUP_Y + rowExtra // VIA +Y 朝后 → 本工程 −z
      return [xMm * MM, -yMm * MM]
    }

    const pickName = (row: number, w: number): string | undefined => {
      const p = ROW_PROFILE[row] ?? 'R4C'
      const width = Math.round(w * 100)
      for (const prof of [p, 'R4C', 'R4', 'R3', 'R2', 'R1']) {
        const name = `K-${prof}-${width}`
        if (capGeos.has(name)) return name
      }
      for (const name of [`K-${p}-100`, 'K-R4C-100']) if (capGeos.has(name)) return name
      return undefined
    }

    // 三种键帽底色：黑 / 深米黄 / 白
    const baseColorFor = (id: string) => (BLACK_KEYS.has(id) ? COL_CAP_DARK : TAN_KEYS.has(id) ? COL_CAP_GREY : COL_CAP)

    const repaint = (entry: CapEntry, id: string) => {
      const isDirty = stateRef.current.dirty.has(id)
      const isPressed = stateRef.current.pressed.has(id)
      const isDark = BLACK_KEYS.has(id) // 只有黑键用浅色字符；灰白键仍用深色字符
      const bg = isPressed ? COL_CAP_PRESSED : isDirty ? COL_CAP_DIRTY : baseColorFor(id)
      const fg = isDirty ? COL_LEGEND_DIRTY : isDark ? COL_LEGEND_LIGHT : COL_LEGEND
      const label = stateRef.current.labels[id] || ''
      const key = bg + fg + label
      if (key === entry.lastPaint) return // 没变化就不重画、不重传纹理
      entry.lastPaint = key
      paintCap(entry.canvas, entry.wU, entry.dU, bg, fg, label)
      entry.tex.needsUpdate = true
    }

    const applyLabels = (next: Record<string, string>) => {
      stateRef.current.labels = next
      caps.forEach((entry, id) => repaint(entry, id))
    }
    const applyStates = () => caps.forEach((entry, id) => repaint(entry, id))

    const gltfLoader = new GLTFLoader()
    const draco = new DRACOLoader()
    draco.setDecoderPath(new URL('draco/', document.baseURI).href)
    gltfLoader.setDRACOLoader(draco)
    gltfLoader.load(
      keycapGlbUrl,
      (gltf) => {
        if (dead) return
        gltf.scene.traverse((o) => {
          const m = o as THREE.Mesh
          if (!m.isMesh) return
          if (capGeos.has(m.name)) return
          const geo = (m.geometry as THREE.BufferGeometry).clone()
          if (!geo.attributes.normal) geo.computeVertexNormals()
          geo.rotateX(-Math.PI / 2) // VIA 的 +Z 朝上 → 本工程 +Y
          geo.computeBoundingBox()
          const bb = geo.boundingBox!
          // 水平居中，底面落到 0（VIA 用 maxZ 做同样的事）
          geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2)
          geo.scale(MM, MM, MM)
          // VIA 的键帽网格本身就是按标准做的（1u = 18.16mm，格距 19.15mm，缝 0.99mm），
          // 和它声明的 KeycapMetric{keyWidth:18.1, keyXSpacing:1.05} 一致，所以不要缩放。
          applyPlanarUV(geo)
          capGeos.set(m.name, geo)
        })

        for (const spot of AL80_LAYOUT) {
          const isKnob = spot.row === KNOB.row && spot.col === KNOB.col
          const [cx, cz] = capPos(spot.x, spot.y, spot.w, 1)
          // 实测缝宽（键帽边缘到边缘，mm）：F4 与 F5 之间、以及第 0 排与第 1 排之间
          {
            const cxMm = cx * PITCH_MM
            const czMm = cz * PITCH_MM
            const capW = spot.w * PITCH_MM - (PITCH_MM - 9.22 * 2)
            if (spot.row === 0) {
              if (spot.id === '0,4') fGapEdge = cxMm + capW / 2
              if (spot.id === '0,5') fGapMm = Math.abs(cxMm - capW / 2 - fGapEdge)
              row0Front = czMm + (PITCH_MM - CAP_GAP_MM) / 2
            }
            if (spot.row === 1 && !rowGapMm) rowGapMm = Math.abs(czMm - (PITCH_MM - CAP_GAP_MM) / 2 - row0Front)
            // 底排：Alt 与空格、空格与 Fn 之间的缝（你反馈 fn 和空格"没挨着"那处）
            if (spot.id === '5,2' || spot.id === '5,6' || spot.id === '5,10') {
              const g2 = capGeos.get(pickName(spot.row, spot.w) ?? '')
              const realW = g2?.boundingBox ? (g2.boundingBox.max.x - g2.boundingBox.min.x) * PITCH_MM : capW
              bottomDbg.push({ id: spot.id, mesh: pickName(spot.row, spot.w), wMm: +realW.toFixed(1), cxMm: +cxMm.toFixed(1) })
              if (spot.id !== '5,2') bottomGaps.push(+(cxMm - realW / 2 - bottomEdge).toFixed(2))
              bottomEdge = cxMm + realW / 2
            }
          }

          if (isKnob) {
            // 旋钮：直接一个圆柱体（真机就是 18mm 直径、露出 12.5mm 的金属旋钮）
            {
              const r = (KNOB_DIA_MM / 2) * MM
              const h = KNOB_H_MM * MM
              const cyl = new THREE.CylinderGeometry(r, r, h, 48, 1, false)
              const knob = new THREE.Mesh(
                cyl,
                new THREE.MeshPhongMaterial({
                  color: new THREE.Color(COL_KNOB),
                  shininess: 70,
                  reflectivity: 0.8,
                  specular: new THREE.Color(COL_SPEC_CASE),
                }),
              )
              // CylinderGeometry 原点在中心，抬到"底面贴住机身顶面"的位置
              knob.position.set(cx, h / 2 + CASE_Z_MM * MM, cz)
              knob.castShadow = true
              knob.receiveShadow = true
              scene.add(knob)
              knobDims = { dia: KNOB_DIA_MM, height: KNOB_H_MM }
            }
            const hit = new THREE.Mesh(
              new THREE.CylinderGeometry(0.5, 0.5, 0.9, 12),
              new THREE.MeshBasicMaterial({ visible: false }),
            )
            hit.position.set(cx, 0.35, cz)
            hit.userData = { row: spot.row, col: spot.col }
            scene.add(hit)
            pickables.push(hit)
            continue
          }

          const geoKey = pickName(spot.row, spot.w)
          const geo = geoKey ? capGeos.get(geoKey) : undefined
          if (!geo || !geoKey) continue
          geo.computeBoundingBox()
          const bb = geo.boundingBox!
          const baseW = bb.max.x - bb.min.x
          // 照 getScale：标准键宽直接用原网格（scale 1），宽度不符时才拉伸兜底
          const targetW = (spot.w * PITCH_MM - 1.05) * MM
          const sx = Math.abs(baseW - targetW) / targetW > 0.02 ? targetW / baseW : 1
          const capId = spot.row + ',' + spot.col
          // 反斜杠键（1,14）跟普通字母键同色，不算修饰键
          const isMod = capId !== '1,14' && (spot.w > 1.2 || spot.row === 0 || spot.row === 5 || spot.col === 14)

          const canvas = document.createElement('canvas')
          const tex = new THREE.CanvasTexture(canvas)
          tex.colorSpace = THREE.SRGBColorSpace
          tex.anisotropy = 4
          // keycap.tsx：材质底色 lightgrey × 贴图 —— 键帽颜色是被这个灰压过的
          const mat = new THREE.MeshPhongMaterial({
            color: new THREE.Color('#d3d3d3'),
            map: tex,
          })
          const mesh = new THREE.Mesh(geo, mat)
          mesh.scale.set(sx, 1, 1)
          mesh.position.set(cx, 0, cz) // 键帽底面 = 内衬上方 1mm（外壳顶面在 −1mm）
          mesh.castShadow = true
          mesh.receiveShadow = true
          mesh.userData = { row: spot.row, col: spot.col }
          scene.add(mesh)
          pickables.push(mesh)

          const entry: CapEntry = {
            mesh,
            baseY: 0,
            kind: isMod ? 'mod' : 'alpha',
            canvas,
            tex,
            wU: spot.w,
            dU: 1,
            hoverT: 0,
          pressT: 0,
          lastPaint: '',
          }
          const id = `${spot.row},${spot.col}`
          caps.set(id, entry)
          mesh.userData.cap = entry
          repaint(entry, id)
        }

        applyStates()
        applyLabels(stateRef.current.labels)
      },
      undefined,
      (err) => {
        const dbg = (window as unknown as { go?: { main?: { App?: { DebugLog?: (s: string) => void } } } }).go
        dbg?.main?.App?.DebugLog?.('MODEL glb 载入失败: ' + String(err))
      },
    )
    const dumpCapCanvas = () => {
      try {
        const api = (
          window as unknown as { go?: { main?: { App?: { WantShot?: () => boolean; SaveCap?: (s: string) => string } } } }
        ).go?.main?.App
        if (!allowShot) return
        const e = caps.get('0,0')
        const e2 = caps.get('1,1')
        const e3 = caps.get('2,0')
        if (!e) return
        api?.SaveCap?.(e.canvas.toDataURL('image/png'))
        const g = e.canvas.getContext('2d')!
        const sample = (c: HTMLCanvasElement | undefined) => {
          if (!c) return 'n/a'
          const d = c.getContext('2d')!.getImageData(2, 2, 1, 1).data
          return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')
        }
        const dbg2 = (window as unknown as { go?: { main?: { App?: { DebugLog?: (s: string) => void } } } }).go
        dbg2?.main?.App?.DebugLog?.(
          'CAPCOLOR Esc(黑)=' + sample(e.canvas) + ' 白键=' + sample(e2?.canvas) + ' Tab(深米黄)=' + sample(e3?.canvas),
        )
        const d = g.getImageData(0, 0, e.canvas.width, e.canvas.height).data
        let green = 0
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 1] > 170 && d[i] < 130 && d[i + 2] < 130) green++
        }
        const dbg = (window as unknown as { go?: { main?: { App?: { DebugLog?: (s: string) => void } } } }).go
        dbg?.main?.App?.DebugLog?.(
          'CAPCANVAS ' + e.canvas.width + 'x' + e.canvas.height + ' 绿像素=' + green +
            ' 文字=' + JSON.stringify(stateRef.current.labels['0,0']),
        )
      } catch {
        /* 忽略 */
      }
    }

    apiRef.current.applyLabels = applyLabels
    apiRef.current.applyStates = applyStates
    apiRef.current.reset = () => {
      yaw = yawCur = 0
      pitch = pitchCur = TR
      yawVel = pitchVel = 0
      placeCamera()
    }

    // ---- 拾取 + 悬停抬键 ----
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    let hovered: CapEntry | null = null
    let downAt: { x: number; y: number } | null = null
    let lastAt: { x: number; y: number } | null = null
    let dragDist = 0

    const pickAt = (clientX: number, clientY: number) => {
      const r = renderer.domElement.getBoundingClientRect()
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      for (const h of ray.intersectObjects(pickables, false)) {
        const d = h.object.userData
        if (typeof d.row === 'number' && typeof d.col === 'number') return h.object
      }
      return null
    }

    const pickScreenAt = (clientX: number, clientY: number) => {
      if (!scrState.mesh) return false
      const r = renderer.domElement.getBoundingClientRect()
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      // 用一颗比屏幕大一圈的虚拟圆盘做命中判定，好点中
      return ray.intersectObject(scrState.mesh, false).length > 0
    }

    const onDown = (e: PointerEvent) => {
      // 只有按住鼠标左键才进入拖拽视角
      if (e.button !== 0) return
      downAt = { x: e.clientX, y: e.clientY }
      lastAt = { x: e.clientX, y: e.clientY }
      dragDist = 0
      renderer.domElement.setPointerCapture?.(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      if (downAt && lastAt) {
        // 中途松开（比如在窗口外松手）也立刻结束拖拽并回弹
        if ((e.buttons & 1) === 0) {
          endDrag()
          return
        }
        dragDist = Math.max(dragDist, Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y))
        if (dragDist > 4) {
          // 左右摆动、上下俯仰，松手后由弹簧自动回到默认机位
          yaw = clamp(yaw - (e.clientX - lastAt.x) * 0.0035, -YAW_LIM, YAW_LIM)
          pitch = clamp(pitch - (e.clientY - lastAt.y) * 0.003, PITCH_MIN, PITCH_MAX)
        }
        lastAt = { x: e.clientX, y: e.clientY }
        renderer.domElement.style.cursor = 'grabbing'
        return
      }
      const obj = pickAt(e.clientX, e.clientY)
      hovered = (obj?.userData.cap as CapEntry) || null
      // 指到小屏幕就把画面放大（悬停放大镜）
      scrState.hover = scrState.mesh ? pickScreenAt(e.clientX, e.clientY) : false
      renderer.domElement.style.cursor = obj ? 'pointer' : scrState.hover ? 'zoom-in' : 'grab'
    }
    // 结束拖拽：目标角归零，弹簧把视角平滑带回默认机位
    const endDrag = () => {
      if (!downAt) return
      downAt = null
      lastAt = null
      renderer.domElement.style.cursor = 'grab'
      yaw = 0
      pitch = TR
    }
    const onUp = (e: PointerEvent) => {
      const wasDrag = dragDist > 6
      const down = downAt
      downAt = null
      lastAt = null
      renderer.domElement.style.cursor = 'grab'
      if (wasDrag || !down) {
        // 拖过视角 → 自动回归默认视角
        yaw = 0
        pitch = TR
        return
      }
      const obj = pickAt(e.clientX, e.clientY)
      if (obj) pickRef.current?.(obj.userData.row as number, obj.userData.col as number)
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointercancel', endDrag)
    renderer.domElement.style.cursor = 'grab'


    // ---- 尺寸自适应 ----
    const resize = () => {
      const w = host.clientWidth
      const h = host.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host)
    resize()

    // ---- 每帧 ----
    let raf = 0
    let frames = 0
    const t0 = performance.now()
    let fps = 0
    let lastTs = performance.now()
    let dtMs = 16
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (pausedRef.current) {
        lastTs = performance.now()
        return
      }
      const nowTs = performance.now()
      dtMs = nowTs - lastTs
      lastTs = nowTs
      caps.forEach((entry, id) => {
        const want = entry === hovered ? 1 : 0
        entry.hoverT += (want - entry.hoverT) * 0.28
        // 按下：键帽先快速沉下去，松开弹回（比只换颜色更像"按了"）
        const wantDown = stateRef.current.pressed.has(id) ? 1 : 0
        entry.pressT += (wantDown - entry.pressT) * (wantDown ? 0.55 : 0.3)
        entry.mesh.position.y =
          entry.baseY + entry.hoverT * HOVER_LIFT_MM * MM - entry.pressT * PRESS_DIP_MM * MM
      })
      // 小屏幕：悬停或刚上图时放大，并且抬到键帽平面之上，免得 45×73px 看不清
      if (scrState.mesh) {
        const want = scrState.hover || nowTs < scrState.boostUntil ? 2.35 : 1
        scrState.zoom += (want - scrState.zoom) * 0.16
        const z = scrState.zoom
        scrState.mesh.scale.set(z, 1, z)
        scrState.mesh.position.y = scrState.baseY + (z - 1) * 9 * MM
      }
      // 弹簧积分（半隐式欧拉，dt 夹住防止掉帧炸开）
      if (dtMs > 0) {
        const dt = Math.min(0.05, dtMs / 1000)
        yawVel += ((yaw - yawCur) * SPRING_TENSION - yawVel * SPRING_FRICTION) * dt
        pitchVel += ((pitch - pitchCur) * SPRING_TENSION - pitchVel * SPRING_FRICTION) * dt
        yawCur += yawVel * dt
        pitchCur += pitchVel * dt
        placeCamera()
      }

      renderer.render(scene, camera)
      frames++
      if (frames === 30 && allowShot && !getScreenImage()) {
        // 自检：造一张测试图丢进 store，验证 3D 上的屏会不会跟着变
        const tc = document.createElement('canvas')
        tc.width = 96
        tc.height = 160
        const tg = tc.getContext('2d')!
        tg.fillStyle = '#ff00ff'
        tg.fillRect(0, 0, 96, 160)
        tg.fillStyle = '#00ff00'
        tg.fillRect(0, 120, 96, 40)
        setScreenImage(tc.toDataURL('image/png'))
      }
      if (frames === 30) {
        const dbg = (window as unknown as { go?: { main?: { App?: { DebugLog?: (s: string) => void } } } }).go
        dbg?.main?.App?.DebugLog?.(
          'LABELDUMP ' + AL80_LAYOUT.map((s) => s.id + '=' + (stateRef.current.labels[s.id] || '?')).join(' | '),
        )
      }
      // 开发自检：把当前帧读出来存成 PNG，方便肉眼核对（AL80_SHOT 环境变量开启）
      if (frames === 400) {
        dumpCapCanvas()
        try {
          const api = (
            window as unknown as {
              go?: { main?: { App?: { WantShot?: () => boolean; SaveShot?: (s: string) => string } } }
            }
          ).go?.main?.App
          if (allowShot) {
            const gl = renderer.getContext()
            const w = renderer.domElement.width
            const h = renderer.domElement.height
            const buf = new Uint8Array(w * h * 4)
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
            const c = document.createElement('canvas')
            c.width = w
            c.height = h
            const g2 = c.getContext('2d')!
            const img = g2.createImageData(w, h)
            const [br, bg, bb] = [0x14, 0x19, 0x22]
            for (let y = 0; y < h; y++) {
              const row = (h - 1 - y) * w * 4
              for (let x = 0; x < w; x++) {
                const s = row + x * 4
                const d = (y * w + x) * 4
                const a = buf[s + 3] / 255
                img.data[d] = Math.round(buf[s] * a + br * (1 - a))
                img.data[d + 1] = Math.round(buf[s + 1] * a + bg * (1 - a))
                img.data[d + 2] = Math.round(buf[s + 2] * a + bb * (1 - a))
                img.data[d + 3] = 255
              }
            }
            g2.putImageData(img, 0, 0)
            api?.SaveShot?.(c.toDataURL('image/png'))
          }
        } catch {
          /* 忽略 */
        }
      }
      if (frames === 120) {
        fps = Math.round((120 * 1000) / Math.max(1, performance.now() - t0))
        try {
          const gl = renderer.getContext()
          const w = host.clientWidth
          const h = host.clientHeight
          const samples: number[] = []
          for (const fy of [0.3, 0.42, 0.54]) {
            for (const fx of [0.25, 0.5, 0.75]) {
              const px = new Uint8Array(4)
              gl.readPixels(Math.floor(w * fx), Math.floor(h * fy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
              samples.push(px[0])
            }
          }
          const cb = shell.geometry.boundingBox ?? (shell.geometry.computeBoundingBox(), shell.geometry.boundingBox!)
          const info = renderer.info.render
          const dbg = (window as unknown as { go?: { main?: { App?: { DebugLog?: (s: string) => void } } } }).go
          dbg?.main?.App?.DebugLog?.(
            'MODEL ' +
              JSON.stringify({
                calls: info.calls,
                tris: info.triangles,
                caps: caps.size,
                geos: capGeos.size,
                capTris: pickables.reduce((s, m) => s + ((m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3), 0),
                capY: (() => {
                  let lo = 99
                  let hi = -99
                  caps.forEach((c) => { lo = Math.min(lo, c.baseY); hi = Math.max(hi, c.baseY) })
                  return [lo, hi].map((n) => Math.round(n * 100) / 100)
                })(),
                deckTop: Math.round(CASE_Z_MM * MM * 100) / 100,
                knob: knobDims,
          fGapMm: +fGapMm.toFixed(2),
          bottomGaps, // [Alt→Space, Space→Fn] 实测键帽边缘间距 mm
          bottomDbg,
          rawCaps, // 缩放前的原始网格尺寸（验证 VIA 是否已按标准做好）
          rowGapMm: +rowGapMm.toFixed(2),
          caseBox: [cb.max.x - cb.min.x, cb.max.y - cb.min.y, cb.max.z - cb.min.z].map(
                  (n) => Math.round(n * 100) / 100,
                ),
                samples,
                fps,
              }),
          )
        } catch {
          /* 忽略 */
        }
      }
    }
    tick()

    return () => {
      dead = true
      disposers.forEach((fn) => fn())
      apiRef.current = {}
      cancelAnimationFrame(raf)
      ro.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointermove', onMove)
      draco.dispose()
      caps.forEach((c) => {
        c.tex.dispose()
      })
      capGeos.forEach((g) => g.dispose())
      capGeos.clear()
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        m.geometry?.dispose()
        const mat = m.material as THREE.Material | THREE.Material[]
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat?.dispose()
      })
      renderer.dispose()
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement)
    }
  }, [])

  useEffect(() => {
    apiRef.current.applyLabels?.(labels)
  }, [labels])

  useEffect(() => {
    apiRef.current.applyStates?.()
  }, [dirty, pressed])

  useEffect(() => {
    if (resetKey) apiRef.current.reset?.()
  }, [resetKey])

  return <div className="kbm-host" ref={hostRef} />
}
