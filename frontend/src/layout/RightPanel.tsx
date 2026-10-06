import { CanvasPanel } from '../features/canvas/CanvasPanel'
import { CaptionsPanel } from '../features/captions/CaptionsPanel'
import { setUi, useUi, type RightTab } from '../state/ui'
import { SidePanel } from './SidePanel'

const TABS = [
  { value: 'captions', label: 'Captions' },
  { value: 'canvas', label: 'Canvas & title' },
] as const satisfies readonly { value: RightTab; label: string }[]

export function RightPanel() {
  const tab = useUi((s) => s.rightTab)
  return (
    <SidePanel label="Captions, canvas and title" tabs={TABS} tab={tab} onTabChange={(rightTab) => setUi({ rightTab })}>
      {tab === 'captions' ? <CaptionsPanel /> : <CanvasPanel />}
    </SidePanel>
  )
}
