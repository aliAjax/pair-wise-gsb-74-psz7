import type { GovernanceState, ReleaseCandidate } from '@/models/domain'
import { createSeedState } from '@/models/seed'

const STORAGE_KEY = 'eventrail-governance-v2'
const LEGACY_STORAGE_KEY = 'eventrail-governance-v1'

const normalizeReleases = (releases: ReleaseCandidate[]): ReleaseCandidate[] =>
  releases.map((release) => ({
    ...release,
    blockers: release.blockers ?? [],
    timeline: release.timeline ?? [],
  }))

export const normalizeState = (state: GovernanceState): GovernanceState => ({
  ...state,
  releases: normalizeReleases(state.releases ?? []),
  rollbacks: state.rollbacks ?? [],
  audit: state.audit ?? [],
  baselines: state.baselines ?? [],
})

export const loadState = (): GovernanceState => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    // v1 数据结构没有冻结快照，无法支撑按冻结内容回滚，直接迁移到新的演示基线
    localStorage.removeItem(LEGACY_STORAGE_KEY)
    const seed = normalizeState(createSeedState())
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  try {
    return normalizeState(JSON.parse(raw) as GovernanceState)
  } catch {
    const seed = normalizeState(createSeedState())
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
}

export const saveState = (state: GovernanceState): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(structuredClone(state)))
}

export const resetState = (): GovernanceState => {
  const seed = normalizeState(createSeedState())
  saveState(seed)
  return seed
}

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
