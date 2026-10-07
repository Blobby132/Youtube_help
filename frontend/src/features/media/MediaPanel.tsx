import { Section } from '../../components/ui/Section'
import { ImportFiles } from '../library/ImportFiles'
import { LibraryList } from '../library/LibraryList'
import { useLibrary } from '../library/libraryStore'
import { AutofillSection } from './AutofillSection'
import { PexelsSearch } from './PexelsSearch'

export function MediaPanel() {
  const count = useLibrary((s) => s.items.length)

  return (
    <>
      <Section label="Stock footage" hint="Videos from Pexels, free to use. Add one to put it in your library.">
        <PexelsSearch />
      </Section>

      <AutofillSection />

      <Section label="Your files" hint="Import your own clips and images, e.g. AI clips from ComfyUI.">
        <ImportFiles />
      </Section>

      <Section
        label={`Library${count ? ` · ${count}` : ''}`}
        hint="Shared by all your projects. Drag a clip onto the timeline's video track, or click +."
      >
        <LibraryList />
      </Section>
    </>
  )
}
