import { Film, ImageUp, Library, Search, WandSparkles } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { Section } from '../../components/ui/Section'
import { useUi } from '../../state/ui'
import styles from './MediaPanel.module.css'

export function MediaPanel() {
  const pexelsReady = useUi((s) => s.health?.pexels)
  const [query, setQuery] = useState('')

  return (
    <>
      <Section label="Stock footage" hint="Portrait videos from Pexels, free to use.">
        <form className={styles.search} onSubmit={(event) => event.preventDefault()} role="search">
          <Search size={14} className={styles.searchIcon} aria-hidden />
          <input
            className={styles.searchInput}
            type="search"
            placeholder="airplane window, ocean, city at night…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search Pexels"
          />
          <Button type="submit" variant="primary" size="sm" disabled>
            Search
          </Button>
        </form>
        {pexelsReady === false && (
          <InlineAlert tone="info">
            Add your free Pexels API key to <code>.env</code> as <code>PEXELS_API_KEY</code>, then restart the app.
          </InlineAlert>
        )}
        <EmptyState icon={Film}>Search results appear here. Hover a clip to preview it.</EmptyState>
      </Section>

      <Section label="Auto-fill" hint="Picks keywords from each sentence of the script and fetches a matching clip for it.">
        <Button block icon={WandSparkles} accentIcon disabled>
          Auto-fill from script
        </Button>
      </Section>

      <Section label="Your files" hint="Upload your own video clips and images.">
        <Button block icon={ImageUp} disabled>
          Upload clips or images
        </Button>
      </Section>

      <Section label="Library" hint="Everything you've downloaded or uploaded for this project.">
        <EmptyState icon={Library}>Nothing here yet. Downloaded and uploaded media will be listed here.</EmptyState>
      </Section>
    </>
  )
}
