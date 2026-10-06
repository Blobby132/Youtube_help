import { ListOrdered, Plus } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Checkbox } from '../../components/ui/Checkbox'
import { EmptyState } from '../../components/ui/EmptyState'
import { Section } from '../../components/ui/Section'
import { Segmented } from '../../components/ui/Segmented'
import { updateProject, useProject } from '../../state/project/store'
import type { Ranking } from '../../state/project/types'

const DIRECTIONS = [
  { value: 'down', label: 'Count down 5→1' },
  { value: 'up', label: 'Count up 1→5' },
] as const

export function RankingPanel() {
  const ranking = useProject((p) => p.ranking)
  const set = (patch: Partial<Ranking>) =>
    updateProject((p) => {
      Object.assign(p.ranking, patch)
    })

  return (
    <>
      <Section
        label="Ranking"
        hint="For countdown videos like “Top 5 …”. Each entry shows a big rank number and its label over its timeline segment."
        action={<Checkbox checked={ranking.enabled} onChange={(enabled) => set({ enabled })} />}
      >
        <Segmented
          label="Order"
          options={DIRECTIONS}
          value={ranking.direction}
          onChange={(direction) => set({ direction })}
        />
      </Section>

      <Section label="Entries" hint="Drag to reorder. Link each entry to the clip it should appear over.">
        <EmptyState icon={ListOrdered}>No entries yet. Add one per item in your ranking.</EmptyState>
        <Button block icon={Plus} disabled>
          Add entry
        </Button>
      </Section>
    </>
  )
}
