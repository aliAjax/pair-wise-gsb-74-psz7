import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  DeprecationPlan,
  EventDefinition,
  EventProperty,
  GovernanceState,
  PlatformRule,
  ReleaseApproval,
  ReleaseCandidate,
  ReleaseTimelineEntry,
  RollbackRecord,
} from '@/models/domain'
import { createId, loadState, resetState, saveState } from '@/services/repository'
import {
  affectedDependencies,
  buildReleaseFreeze,
  contractDifferences,
  releaseBlockers,
  releaseReadiness,
  unresolvedBlockers,
  validateGovernance,
} from '@/services/selectors'

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())

  const issues = computed(() => validateGovernance(data.value))

  const persist = (): void => {
    saveState(data.value)
    lastSavedAt.value = new Date().toISOString()
  }

  const audit = (
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
  ): void => {
    data.value.audit.unshift({
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor: '当前用户',
      detail,
      createdAt: new Date().toISOString(),
    })
  }

  const addTimeline = (
    release: ReleaseCandidate,
    action: ReleaseTimelineEntry['action'],
    detail: string,
    actor = '当前用户',
  ): void => {
    const entry: ReleaseTimelineEntry = {
      id: createId('tl'),
      action,
      actor,
      detail,
      createdAt: new Date().toISOString(),
    }
    if (!release.timeline) release.timeline = []
    release.timeline.unshift(entry)
  }

  const saveEvent = (event: EventDefinition): void => {
    const index = data.value.events.findIndex((item) => item.id === event.id)
    const saved = { ...event, updatedAt: new Date().toISOString() }
    if (index >= 0) {
      data.value.events[index] = saved
    } else {
      data.value.events.unshift(saved)
    }
    audit('event', event.id, index >= 0 ? '更新事件' : '创建事件', `${event.key} 契约已保存`)
    persist()
  }

  const saveProperty = (eventId: string, property: EventProperty): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.properties.findIndex((item) => item.id === property.id)
    if (index >= 0) {
      event.properties[index] = property
    } else {
      event.properties.push(property)
    }
    event.updatedAt = new Date().toISOString()
    audit('property', property.id, index >= 0 ? '更新属性' : '新增属性', `${event.key}.${property.name}`)
    persist()
  }

  const deleteProperty = (eventId: string, propertyId: string): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    const property = event?.properties.find((item) => item.id === propertyId)
    if (!event || !property) return
    property.deletedAt = new Date().toISOString()
    event.updatedAt = new Date().toISOString()
    audit('property', property.id, '标记删除', `${event.key}.${property.name} 进入删除兼容期`)
    persist()
  }

  const savePlatformRule = (eventId: string, rule: PlatformRule): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.platformRules.findIndex((item) => item.id === rule.id)
    if (index >= 0) {
      event.platformRules[index] = rule
    } else {
      event.platformRules.push(rule)
    }
    event.updatedAt = new Date().toISOString()
    audit('platform_rule', rule.id, index >= 0 ? '更新平台规则' : '新增平台规则', `${event.key}/${rule.platform}`)
    persist()
  }

  const createRelease = (version: string, title: string, eventIds: string[]): ReleaseCandidate => {
    const differences = contractDifferences(data.value, eventIds)
    const affected = affectedDependencies(data.value, differences)
    const frozenAt = new Date().toISOString()
    const freeze = buildReleaseFreeze(data.value, eventIds, frozenAt)
    const release: ReleaseCandidate = {
      id: createId('rel'),
      version,
      title,
      status: 'reviewing',
      eventIds,
      affectedDependencyIds: affected,
      differences,
      migrationConfirmations: affected.map((dependencyId) => ({
        id: createId('mig'),
        dependencyId,
        version,
        status: 'pending',
        reviewer:
          data.value.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
        note: '',
      })),
      approvals: [
        { id: createId('appr'), role: 'data', actor: '顾清', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'product', actor: '丁禾', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'client', actor: '江驰', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'qa', actor: '余安', status: 'pending', comment: '' },
      ],
      freeze,
      timeline: [
        {
          id: createId('tl'),
          action: 'frozen',
          actor: '当前用户',
          detail: `创建候选并冻结 ${eventIds.length} 个事件、${freeze.dependencies.length} 个下游依赖的契约快照`,
          createdAt: frozenAt,
        },
      ],
      createdAt: frozenAt,
    }
    const blockers = releaseBlockers(data.value, release, issues.value)
    release.blockers = blockers
    if (unresolvedBlockers(blockers).length > 0) {
      release.status = 'blocked'
    }
    data.value.releases.unshift(release)
    data.value.currentVersion = version
    audit(
      'release',
      release.id,
      '创建发布候选',
      `${version} 包含 ${eventIds.length} 个事件，影响 ${affected.length} 个下游依赖，已冻结契约快照` +
        (release.status === 'blocked'
          ? `，${unresolvedBlockers(blockers).length} 项旧字段引用/严重校验未解，停在待处理区`
          : ''),
    )
    persist()
    return release
  }

  /** 重新检测阻断项；全部解除时候选从待处理区进入评审 */
  const recheckBlockers = (releaseId: string): { blocking: number } => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return { blocking: 0 }
    const blockers = releaseBlockers(data.value, release, issues.value)
    release.blockers = blockers
    const blocking = unresolvedBlockers(blockers).length
    if (blocking === 0 && release.status === 'blocked') {
      release.status = 'reviewing'
      addTimeline(release, 'unblocked', '旧字段引用与严重校验阻断项已全部解除，候选进入评审')
      audit('release', release.id, '解除待处理', `${release.version} 阻断项清零，恢复评审`)
    }
    persist()
    return { blocking }
  }

  /** 在评审页直接解除某个旧字段引用：从依赖中移除该字段引用后重检 */
  const resolveBlockerReference = (releaseId: string, blockerId: string): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const blocker = release?.blockers?.find((item) => item.id === blockerId)
    if (!release || !blocker || blocker.resolved) return
    if (blocker.kind === 'deleted_property_referenced' && blocker.dependencyId && blocker.propertyId) {
      const dependency = data.value.dependencies.find(
        (item) => item.id === blocker.dependencyId,
      )
      if (dependency) {
        dependency.propertyRefs = dependency.propertyRefs.filter(
          (reference) =>
            !(
              reference.eventId === blocker.eventId &&
              reference.propertyId === blocker.propertyId
            ),
        )
        audit(
          'dependency',
          dependency.id,
          '移除旧字段引用',
          `${dependency.name} 已移除 ${blocker.eventKey}.${blocker.fieldName ?? blocker.propertyId} 引用`,
        )
      }
    }
    recheckBlockers(releaseId)
  }

  const confirmMigration = (
    releaseId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
  ): boolean => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const confirmation = release?.migrationConfirmations.find((item) => item.id === confirmationId)
    if (!release || !confirmation) return false
    if (release.status === 'blocked') return false
    confirmation.status = 'confirmed'
    confirmation.reviewer = reviewer
    confirmation.note = note
    confirmation.confirmedAt = new Date().toISOString()
    const dependency = data.value.dependencies.find((item) => item.id === confirmation.dependencyId)
    if (dependency) dependency.status = 'migrated'
    audit('dependency', confirmation.dependencyId, '确认迁移', `${reviewer}：${note}`)
    persist()
    return true
  }

  const updateApproval = (
    releaseId: string,
    role: ReleaseApproval['role'],
    status: ReleaseApproval['status'],
    actor: string,
    comment: string,
  ): boolean => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const approval = release?.approvals.find((item) => item.role === role)
    if (!release || !approval) return false
    if (release.status === 'blocked') return false
    approval.status = status
    approval.actor = actor
    approval.comment = comment
    approval.createdAt = new Date().toISOString()
    audit('release', releaseId, status === 'approved' ? '审批通过' : '审批驳回', `${role}：${comment}`)
    persist()
    return true
  }

  type PublishResult =
    | { ok: true }
    | { ok: false; reason: 'not_found' | 'blocked' | 'migration' | 'approval' | 'readiness' }

  const publishRelease = (releaseId: string): PublishResult => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return { ok: false, reason: 'not_found' }
    if (release.status === 'published') return { ok: false, reason: 'not_found' }
    if (release.status === 'rolled_back') return { ok: false, reason: 'not_found' }

    // 发布前实时重检：冻结后契约又发生变化时，以当前状态为准，旧字段引用/严重校验绝不放行
    const blockers = releaseBlockers(data.value, release, issues.value)
    release.blockers = blockers
    if (unresolvedBlockers(blockers).length > 0) {
      if (release.status !== 'blocked') release.status = 'blocked'
      persist()
      return { ok: false, reason: 'blocked' }
    }

    const readiness = releaseReadiness(release, issues.value)
    const migrationsReady = release.migrationConfirmations.every((item) => item.status === 'confirmed')
    const approvalsReady = release.approvals.every((item) => item.status === 'approved')
    if (!migrationsReady) return { ok: false, reason: 'migration' }
    if (!approvalsReady) return { ok: false, reason: 'approval' }
    if (readiness < 90) return { ok: false, reason: 'readiness' }

    const publishedAt = new Date().toISOString()
    release.status = 'published'
    release.publishedAt = publishedAt
    release.eventIds.forEach((eventId) => {
      const event = data.value.events.find((item) => item.id === eventId)
      if (event) {
        event.status = 'published'
        data.value.baselines.unshift({
          id: createId('base'),
          eventId,
          version: event.version,
          properties: structuredClone(event.properties),
          status: 'published',
          createdAt: publishedAt,
        })
      }
    })
    addTimeline(release, 'published', `${release.version} 发布，生成 ${release.eventIds.length} 个事件新版本基线`)
    audit('release', release.id, '发布契约', `${release.version} 已发布，冻结快照保留用于回滚`)
    persist()
    return { ok: true }
  }

  const saveDeprecation = (plan: DeprecationPlan): void => {
    const index = data.value.deprecations.findIndex((item) => item.id === plan.id)
    if (index >= 0) {
      data.value.deprecations[index] = plan
    } else {
      data.value.deprecations.unshift(plan)
    }
    const event = data.value.events.find((item) => item.id === plan.eventId)
    if (event && plan.status === 'stopped') event.status = 'deprecated'
    if (event && plan.status === 'retired') event.status = 'retired'
    audit('deprecation', plan.id, '更新废弃计划', `${event?.key ?? plan.eventId}：${plan.status}`)
    persist()
  }

  type RollbackResult = { ok: true; record: RollbackRecord } | { ok: false; reason: 'not_found' | 'not_published' | 'no_freeze' }

  const executeRollback = (
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
  ): RollbackResult => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return { ok: false, reason: 'not_found' }
    if (release.status !== 'published') return { ok: false, reason: 'not_published' }
    const freeze = release.freeze
    if (!freeze) return { ok: false, reason: 'no_freeze' }

    const createdAt = new Date().toISOString()

    // 1. 恢复范围内事件：状态、版本、属性（含已下线字段的删除标记）、平台规则
    let restoredEventCount = 0
    freeze.events.forEach((frozenEvent) => {
      const event = data.value.events.find((item) => item.id === frozenEvent.eventId)
      if (!event) return
      event.status = frozenEvent.status
      event.version = frozenEvent.version
      event.properties = structuredClone(frozenEvent.properties)
      event.platformRules = structuredClone(frozenEvent.platformRules)
      event.updatedAt = createdAt
      restoredEventCount += 1
    })

    // 2. 恢复依赖的状态、事件范围与字段引用（迁移确认造成的 migrated 等改动一并还原）
    let restoredDependencyCount = 0
    freeze.dependencies.forEach((frozenDependency) => {
      const dependency = data.value.dependencies.find(
        (item) => item.id === frozenDependency.dependencyId,
      )
      if (!dependency) return
      dependency.status = frozenDependency.status
      dependency.eventIds = [...frozenDependency.eventIds]
      dependency.propertyRefs = frozenDependency.propertyRefs.map((reference) => ({ ...reference }))
      restoredDependencyCount += 1
    })

    // 3. 移除本次发布写入的基线，只保留冻结时已存在的基线
    const keptBaselineIds = new Set(freeze.baselineIds)
    const beforeBaselineCount = data.value.baselines.length
    data.value.baselines = data.value.baselines.filter(
      (baseline) =>
        !release.eventIds.includes(baseline.eventId) || keptBaselineIds.has(baseline.id),
    )
    const removedBaselineCount = beforeBaselineCount - data.value.baselines.length

    // 4. 恢复版本指针与发布状态
    data.value.currentVersion = freeze.currentVersion
    release.status = 'rolled_back'
    release.rolledBackAt = createdAt

    const record: RollbackRecord = {
      id: createId('rollback'),
      releaseId,
      version: release.version,
      reason,
      operator: '当前用户',
      scope,
      createdAt,
      status: 'executed',
      evidence,
      frozenAt: freeze.frozenAt,
      restoredEventCount,
      restoredDependencyCount,
      removedBaselineCount,
    }
    data.value.rollbacks.unshift(record)
    addTimeline(
      release,
      'rolled_back',
      `按 ${new Date(freeze.frozenAt).toLocaleString('zh-CN')} 冻结快照恢复 ${restoredEventCount} 个事件、${restoredDependencyCount} 个依赖，移除 ${removedBaselineCount} 条发布基线：${reason}`,
    )
    audit(
      'rollback',
      record.id,
      '执行回滚',
      `${release.version} 已按冻结快照恢复事件/属性/依赖状态，移除发布基线 ${removedBaselineCount} 条：${reason}`,
    )
    persist()
    return { ok: true, record }
  }

  const verifyRollback = (rollbackId: string, evidence: string): boolean => {
    const record = data.value.rollbacks.find((item) => item.id === rollbackId)
    if (!record || record.status !== 'executed') return false
    record.status = 'verified'
    record.evidence = evidence
    const release = data.value.releases.find((item) => item.id === record.releaseId)
    if (release) {
      addTimeline(release, 'rollback_verified', `回滚结果验证通过：${evidence}`)
    }
    audit('rollback', record.id, '验证回滚', evidence)
    persist()
    return true
  }

  const resetDemo = (): void => {
    data.value = resetState()
    lastSavedAt.value = new Date().toISOString()
  }

  const exportContract = (eventIds?: string[]): string => {
    const selectedEvents = eventIds
      ? data.value.events.filter((event) => eventIds.includes(event.id))
      : data.value.events
    return JSON.stringify(
      {
        version: data.value.currentVersion,
        generatedAt: new Date().toISOString(),
        events: selectedEvents.map((event) => ({
          key: event.key,
          displayName: event.displayName,
          version: event.version,
          trigger: event.trigger,
          platforms: event.platformRules.map((rule) => ({
            platform: rule.platform,
            enabled: rule.enabled,
            trigger: rule.trigger,
          })),
          properties: event.properties
            .filter((property) => !property.deletedAt)
            .map(({ name, type, required, enumValues, description }) => ({
              name,
              type,
              required,
              enumValues,
              description,
            })),
        })),
      },
      null,
      2,
    )
  }

  return {
    data,
    lastSavedAt,
    issues,
    saveEvent,
    saveProperty,
    deleteProperty,
    savePlatformRule,
    createRelease,
    recheckBlockers,
    resolveBlockerReference,
    confirmMigration,
    updateApproval,
    publishRelease,
    saveDeprecation,
    executeRollback,
    verifyRollback,
    resetDemo,
    exportContract,
  }
})
