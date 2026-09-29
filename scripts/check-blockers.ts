import { createSeedState } from '@/models/seed'
const state = createSeedState()
const rel = state.releases.find((r) => r.id === 'rel-001')!
console.log('status:', rel.status, 'blockers:', rel.blockers.length)
for (const b of rel.blockers) console.log(' -', b.severity, b.kind, b.title, '| restore:', b.resolvableByRestore)
console.log('timeline:', rel.timeline.length, 'freeze events:', rel.freeze?.events.length)
