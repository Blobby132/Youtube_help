import { Checkbox } from '../../components/ui/Checkbox'
import { Section } from '../../components/ui/Section'
import { setUi, useUi } from '../../state/ui'
import { GenerateSection } from '../generate/GenerateSection'
import { ImportFiles } from '../library/ImportFiles'
import { LibraryList } from '../library/LibraryList'
import { isScenePreview, useLibrary } from '../library/libraryStore'
import { AutofillSection } from './AutofillSection'
import { StockSearch } from './StockSearch'
import { SOURCE_LABEL } from './stockSources'
import { useCurrentSource } from './stockStore'

export function MediaPanel() {
  const previews = useLibrary((s) => s.items.filter(isScenePreview).length)
  const showPreviews = useUi((s) => s.showScenePreviews)
  const count = useLibrary((s) => s.items.length) - (showPreviews ? 0 : previews)
  const source = useCurrentSource()

  return (
    <>
      <Section label="Stock footage" hint={`Videos from ${SOURCE_LABEL[source]}, free to use. Add one to download it into your library.`}>
        <StockSearch />
      </Section>

      <AutofillSection />

      <GenerateSection />

      <Section label="Your files" hint="Import your own clips and images, e.g. AI clips from ComfyUI.">
        <ImportFiles />
      </Section>

      <Section
        label={`Library${count ? ` · ${count}` : ''}`}
        hint="Shared by all your projects. Drag a clip onto the timeline's video track, or click +."
        action={
          previews > 0 && (
            <Checkbox label={`Scene previews (${previews})`} checked={showPreviews} onChange={(checked) => setUi({ showScenePreviews: checked })} />
          )
        }
      >
        <LibraryList />
      </Section>
    </>
  )
}
