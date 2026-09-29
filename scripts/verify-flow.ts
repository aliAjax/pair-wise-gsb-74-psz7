// 端到端逻辑验证：冻结 → 待处理阻断 → 迁移/恢复 → 发布 → 回滚
import { setActivePinia, createPinia } from 'pinia'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  },
})
if (!globalThis.structuredClone) {
  globalThis.structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value))
}

setActivePinia(createPinia())
const { useGovernanceStore } = await import('@/stores/governance')

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    console.error(`❌ ${message}`)
    process.exitCode = 1
  } else {
    console.log(`✅ ${message}`)
  }
}

const store = useGovernanceStore()
const release = store.data.releases.find((item) => item.id === 'rel-001')!

// 1. 种子候选应被冻结并停在待处理区
assert(release.status === 'blocked', 'rel-001 处于待处理区')
assert(Boolean(release.freeze), '创建候选时保存了冻结快照')
assert(release.freeze!.events.length === 3, '冻结快照包含 3 个事件')
assert(release.freeze!.dependencies.length === 6, '冻结快照包含 6 个下游依赖')
assert(release.blockers.length === 4, `阻断项数量为 4（实际 ${release.blockers.length}）`)
const criticalRef = release.blockers.find((b) => b.propertyId === 'prop-024')
assert(Boolean(criticalRef), '阻断项指出 dep-004 对旧字段 prop-024(experiment_id) 的引用')
assert(criticalRef!.resolvableByRestore, '冻结中存在旧字段，可一键恢复')
// 2. 阻断未解时审批与发布都被拒绝
const approvalRejected = !store.updateApproval(release.id, 'product', 'approved', '丁禾', '强行通过')
assert(approvalRejected, '阻断未解时审批被拦截')
assert(
  store.publishRelease(release.id)?.includes('阻断') ?? false,
  '发布门禁因阻断项拒绝放行',
)

// 3. 按冻结内容恢复 experiment_id，对应阻断解除
const blockerCountBeforeRestore = store.blockersFor(release.id).length
store.restoreFrozenProperty(release.id, criticalRef!.id)
const evt003 = store.data.events.find((e) => e.id === 'evt-003')!
assert(
  Boolean(evt003.properties.find((p) => p.id === 'prop-024' && !p.deletedAt)),
  '恢复后 experiment_id 回到当前契约',
)
assert(
  store.blockersFor(release.id).length === blockerCountBeforeRestore - 1,
  '恢复字段后阻断项减少',
)
assert(
  release.timeline.some((t) => t.phase === 'property_restored'),
  '字段恢复写入发布时间线',
)

// 4. 确认剩余受影响依赖迁移（dep-001 / dep-005 / dep-006）
const pending = release.migrationConfirmations.filter((m) => m.status !== 'confirmed')
pending.forEach((m) =>
  store.confirmMigration(release.id, m.id, m.reviewer || '负责人', '已完成字段迁移'),
)
assert(
  release.migrationConfirmations.every((m) => m.status === 'confirmed'),
  '全部受影响依赖完成迁移确认',
)
assert(
  store.blockersFor(release.id).every((b) => b.kind !== 'deleted_property_referenced'),
  '旧字段引用阻断全部解除',
)

// 5. 仍有类型变化等严重校验：必须修复事件属性才能解除
const stillBlocked = release.status === 'blocked'
assert(stillBlocked, '类型变化等严重校验未解时仍停在待处理区')

const orderId = store.data.events.find((e) => e.id === 'evt-001')!.properties.find((p) => p.id === 'prop-001')!
orderId.type = 'number'
const pageNo = store.data.events.find((e) => e.id === 'evt-003')!.properties.find((p) => p.id === 'prop-014')!
pageNo.type = 'string'
store.saveProperty('evt-001', orderId)
store.saveProperty('evt-003', pageNo)

// 重复事件阻断通过改名解决
const legacyEvent = store.data.events.find((e) => e.id === 'evt-005')!
legacyEvent.key = 'legacy_coupon_grant_archive'
legacyEvent.displayName = '营销活动页历史领券归档事件'
store.saveEvent(legacyEvent)

assert(store.blockersFor(release.id).length === 0, '全部严重校验阻断解除')
assert(release.status === 'reviewing', '严重校验修复后候选自动回到评审中')

// 6. 审批齐备后发布
const roles = ['product', 'client', 'qa'] as const
roles.forEach((role, i) =>
  store.updateApproval(release.id, role, 'approved', ['丁禾', '江驰', '余安'][i], '通过'),
)
const publishError = store.publishRelease(release.id)
assert(publishError === null, '阻断清零、迁移与审批齐备后发布成功')
assert(release.status === 'published', '候选状态为已发布')
assert(store.data.currentVersion === '2026.10.0', '发布后当前版本更新')
assert((release.publishedBaselineIds ?? []).length === 3, '发布写入 3 个事件基线')

// 7. 发布后制造“坏值”：删除一个字段
pageNo.deletedAt = new Date().toISOString()
store.saveProperty('evt-003', pageNo)

// 8. 回滚按冻结内容恢复事件、属性与依赖
const record = store.executeRollback(release.id, '线上看板异常', '全端', 'INC-001')
assert(Boolean(record), '回滚执行成功并产生记录')
assert(release.status === 'rolled_back', '候选状态为已回滚')
assert(store.data.currentVersion === '2026.09.0', '当前版本恢复到冻结时记录的上一版本')
const rolledBackPageNo = store.data.events
  .find((e) => e.id === 'evt-003')!
  .properties.find((p) => p.id === 'prop-014')!
assert(!rolledBackPageNo.deletedAt, '回滚恢复了被删除字段的坏值')
const restoredOrderId = store.data.events
  .find((e) => e.id === 'evt-001')!
  .properties.find((p) => p.id === 'prop-001')!
assert(restoredOrderId.type === 'string', '回滚把 order_id 类型恢复到冻结时的 string')
const dep001 = store.data.dependencies.find((d) => d.id === 'dep-001')!
assert(dep001.status === 'active', '下游依赖状态恢复到冻结时的启用状态')
const dep004 = store.data.dependencies.find((d) => d.id === 'dep-004')!
assert(
  dep004.propertyRefs.some((ref) => ref.propertyId === 'prop-024'),
  '迁移确认时移除的旧字段引用按冻结内容恢复',
)
assert(
  !store.data.baselines.some((b) => release.publishedBaselineIds?.includes(b.id)),
  '本次发布写入的基线已撤销',
)
assert(
  release.timeline[0]?.phase === 'rolled_back' &&
    release.timeline.some((t) => t.phase === 'published') &&
    release.timeline.some((t) => t.phase === 'created'),
  '发布与回滚经过均保留在时间线',
)

console.log(process.exitCode ? '\n存在失败断言' : '\n全部断言通过')
