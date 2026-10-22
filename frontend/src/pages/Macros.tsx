import Macros from '../components/Macros'
import type { DeviceStatus } from '../lib/bridge'

interface Props {
  status: DeviceStatus | null
  onNeedConnect: () => void
}

/** 「键盘宏」模块：宏槽位浏览 + 编辑 + 写入 */
export default function MacrosPage({ status, onNeedConnect }: Props) {
  return (
    <div className="page">
      <Macros connected={Boolean(status?.connected)} onNeedConnect={onNeedConnect} />
    </div>
  )
}
