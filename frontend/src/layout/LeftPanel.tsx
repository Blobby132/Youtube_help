import { MediaPanel } from '../features/media/MediaPanel'
import { MixSection } from '../features/mix/MixSection'
import { PronunciationsSection } from '../features/pronunciations/PronunciationsSection'
import { RankingPanel } from '../features/ranking/RankingPanel'
import { ScenesPanel } from '../features/scenes/ScenesPanel'
import { ScriptSection } from '../features/script/ScriptSection'
import { VoiceoverSection } from '../features/voiceover/VoiceoverSection'
import { setUi, useUi, type LeftTab } from '../state/ui'
import { SidePanel } from './SidePanel'

const TABS = [
  { value: 'script', label: 'Script & voice' },
  { value: 'media', label: 'Media' },
  { value: 'scenes', label: 'Scenes' },
  { value: 'ranking', label: 'Ranking' },
] as const satisfies readonly { value: LeftTab; label: string }[]

export function LeftPanel() {
  const tab = useUi((s) => s.leftTab)
  return (
    <SidePanel label="Script, media, scenes and ranking" tabs={TABS} tab={tab} onTabChange={(leftTab) => setUi({ leftTab })}>
      {tab === 'script' && (
        <>
          <ScriptSection />
          <VoiceoverSection />
          <PronunciationsSection />
          <MixSection />
        </>
      )}
      {tab === 'media' && <MediaPanel />}
      {tab === 'scenes' && <ScenesPanel />}
      {tab === 'ranking' && <RankingPanel />}
    </SidePanel>
  )
}
