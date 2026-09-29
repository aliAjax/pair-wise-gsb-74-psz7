import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  DeprecationPlan,
  EventDefinition,
  EventProperty,
  GovernanceState,
  PlatformRule,
  ReleaseApproval,
  ReleaseBlocker,
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
  validateGovernance,
} from '@/services/selectors'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())
  let suppressBlockerRefresh = false

  const issues = computed(() => validateGovernance(data.value))

  const roleLabel = (role: ReleaseApproval['role']): string =>
    ({ data: '数据负责人', product: '产品负责人', client: '客户端负责人', qa: '测试负责人' })[role]

  const persist = (): void => {
    // 契约编辑落库后自动重评候选阻断状态（创建候选时由调用方自行评估）
    if (!suppressBlockerRefresh) refreshReleaseBlockers()
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
    const affected = affectedDependencies(data.value, differences, eventIds)
    const previousVersion =
      data.value.releases.find((release) => release.status === 'published')?.version ??
      data.value.currentVersion
    const createdAt = new Date().toISOString()
    const release: ReleaseCandidate = {
      id: createId('rel'),
      version,
      title,
      status: 'blocked',
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
      // 创建候选即冻结当时的事件、属性与依赖关系
      freeze: buildReleaseFreeze(data.value, eventIds, previousVersion),
      blockers: [],
      timeline: [
        {
          id: createId('tl'),
          phase: 'created',
          actor: '当前用户',
          detail: `创建候选 ${version}，包含 ${eventIds.length} 个事件，冻结 ${affected.length} 个受影响下游依赖`,
          at: createdAt,
        },
      ],
      createdAt,
    }
    release.blockers = releaseBlockers(release, data.value)
    if (release.blockers.length === 0) release.status = 'reviewing'
    data.value.releases.unshift(release)
    // 版本号在正式发布时才成为当前契约版本
    audit(
      'release',
      release.id,
      release.blockers.length > 0 ? '创建发布候选（待处理阻断）' : '创建发布候选',
      `${version} 包含 ${eventIds.length} 个事件，影响 ${affected.length} 个下游依赖，阻断项 ${release.blockers.length} 个`,
    )
    if (release.blockers.length > 0) {
      appendTimeline(
        release,
        'blocked',
        '系统',
        `候选停留在待处理区：${release.blockers.map((item) => item.title).join('；')}`,
      )
    }
    suppressBlockerRefresh = true
    persist()
    suppressBlockerRefresh = false
    return release
  }

  /** 按当前契约重新评估未终结候选的阻断状态，阻断解除后自动回到评审中 */
  const refreshReleaseBlockers = (): void => {
    data.value.releases.forEach((release) => {
      if (
        release.status !== 'blocked' &&
        release.status !== 'reviewing' &&
        release.status !== 'approved'
      ) {
        return
      }
      if (!release.freeze) return
      const blockers = releaseBlockers(release, data.value)
      const hadBlockers = release.blockers.length > 0
      release.blockers = blockers
      if (blockers.length > 0 && release.status !== 'blocked') {
        release.status = 'blocked'
        appendTimeline(release, 'blocked', '系统', `新增未解决阻断：${blockers[0]?.title ?? ''}`)
      } else if (blockers.length === 0 && (release.status === 'blocked' || hadBlockers)) {
        release.status = 'reviewing'
        appendTimeline(release, 'unblocked', '系统', '旧字段引用与严重校验已全部解决，候选回到评审中')
      }
    })
  }

  const appendTimeline = (
    release: ReleaseCandidate,
    phase: ReleaseTimelineEntry['phase'],
    actor: string,
    detail: string,
  ): void => {
    release.timeline.unshift({
      id: createId('tl'),
      phase,
      actor,
      detail,
      at: new Date().toISOString(),
    })
  }

  const blockersFor = (releaseId: string): ReleaseBlocker[] =>
    data.value.releases.find((item) => item.id === releaseId)?.blockers ?? []

  const confirmMigration = (
    releaseId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const confirmation = release?.migrationConfirmations.find((item) => item.id === confirmationId)
    if (!release || !confirmation) return
    if (release.status === 'blocked' && release.blockers.length > 0) {
      const staleRefs = release.blockers.filter(
        (blocker) =>
          blocker.kind === 'deleted_property_referenced' &&
          blocker.dependencyIds.includes(confirmation.dependencyId),
      )
      // 迁移确认意味着下游已切换字段：移除仍指向已删除/不存在属性的旧引用
      staleRefs.forEach((blocker) => {
        const dependency = data.value.dependencies.find(
          (item) => item.id === confirmation.dependencyId,
        )
        if (!dependency || !blocker.eventId || !blocker.propertyId) return
        dependency.propertyRefs = dependency.propertyRefs.filter(
          (reference) =>
            !(
              reference.eventId === blocker.eventId &&
              reference.propertyId === blocker.propertyId
            ),
        )
      })
    }
    confirmation.status = 'confirmed'
    confirmation.reviewer = reviewer
    confirmation.note = note
    confirmation.confirmedAt = new Date().toISOString()
    const dependency = data.value.dependencies.find((item) => item.id === confirmation.dependencyId)
    if (dependency) dependency.status = 'migrated'
    appendTimeline(
      release,
      'migration_confirmed',
      reviewer,
      `${dependency?.name ?? confirmation.dependencyId} 确认迁移：${note}`,
    )
    audit('dependency', confirmation.dependencyId, '确认迁移', `${reviewer}：${note}`)
    refreshReleaseBlockers()
    persist()
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
    appendTimeline(
      release,
      status === 'approved' ? 'approved' : 'rejected',
      actor,
      `${roleLabel(role)}${status === 'approved' ? '审批通过' : '驳回'}：${comment}`,
    )
    audit('release', releaseId, status === 'approved' ? '审批通过' : '审批驳回', `${role}：${comment}`)
    persist()
    return true
  }

  /**
   * 发布门禁：旧字段引用或严重校验阻断未解除时一律拒绝，
   * 迁移确认与四角色审批同样必须齐备。返回 null 表示放行成功。
   */
  const publishRelease = (releaseId: string): string | null => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return '发布候选不存在'
    if (!release.freeze) return '候选缺少冻结快照，无法发布'
    const blockers = releaseBlockers(release, data.value)
    if (blockers.length > 0) return `仍有 ${blockers.length} 个阻断项未解决：${blockers[0]?.title ?? ''}`
    const pendingMigration = release.migrationConfirmations.find((item) => item.status !== 'confirmed')
    if (pendingMigration) return '存在未确认的下游迁移'
    const pendingApproval = release.approvals.find((item) => item.status !== 'approved')
    if (pendingApproval) return '四角色审批尚未全部通过'

    release.status = 'published'
    release.blockers = []
    release.publishedAt = new Date().toISOString()
    const baselineIds: string[] = []
    release.eventIds.forEach((eventId) => {
      const event = data.value.events.find((item) => item.id === eventId)
      if (event) {
        event.status = 'published'
        const baselineId = createId('base')
        baselineIds.push(baselineId)
        data.value.baselines.unshift({
          id: baselineId,
          eventId,
          version: event.version,
          properties: clone(event.properties),
          createdAt: new Date().toISOString(),
          status: 'published',
        })
      }
    })
    release.publishedBaselineIds = baselineIds
    data.value.currentVersion = release.version
    appendTimeline(release, 'published', '当前用户', `${release.version} 已发布，写入 ${baselineIds.length} 个事件基线`)
    audit('release', release.id, '发布契约', `${release.version} 已发布`)
    persist()
    return null
  }

  /** 按候选冻结内容恢复被删除字段，解除对应的旧字段引用阻断 */
  const restoreFrozenProperty = (releaseId: string, blockerId: string): boolean => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const blocker = release?.blockers.find((item) => item.id === blockerId)
    if (!release || !blocker || !blocker.eventId || !blocker.propertyId) return false
    const frozenEvent = release.freeze?.events.find((item) => item.id === blocker.eventId)
    const frozenProperty = frozenEvent?.properties.find((item) => item.id === blocker.propertyId)
    if (!frozenProperty) return false

    const event = data.value.events.find((item) => item.id === blocker.eventId)
    const restoredProperty = clone(frozenProperty)
    delete restoredProperty.deletedAt
    if (event) {
      const existing = event.properties.find((item) => item.id === blocker.propertyId)
      if (existing) {
        delete existing.deletedAt
      } else {
        event.properties.push(restoredProperty)
      }
      event.updatedAt = new Date().toISOString()
    } else if (frozenEvent) {
      const restoredEvent = clone(frozenEvent)
      data.value.events.push(restoredEvent)
    }
    appendTimeline(
      release,
      'property_restored',
      '当前用户',
      `按冻结快照恢复字段 ${blocker.eventId}.${blocker.propertyName ?? blocker.propertyId}`,
    )
    audit(
      'property',
      blocker.propertyId,
      '按冻结内容恢复字段',
      `${release.version} 回滚前置恢复：${blocker.propertyName ?? blocker.propertyId}`,
    )
    refreshReleaseBlockers()
    persist()
    return true
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

  /**
   * 按冻结快照执行回滚：恢复事件、属性与依赖关系，撤销发布基线，
   * 不再只改版本状态。
   */
  const executeRollback = (
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
  ): RollbackRecord | null => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return null
    if (release.status !== 'published' || !release.freeze) {
      return null
    }

    const freeze = release.freeze
    let propertiesRestored = 0

    // 恢复事件与其属性、平台规则到冻结时状态
    freeze.events.forEach((frozenEvent) => {
      const current = data.value.events.find((item) => item.id === frozenEvent.id)
      const activeBefore = new Set(
        (current?.properties ?? []).filter((property) => !property.deletedAt).map((item) => item.id),
      )
      if (current) {
        const index = data.value.events.indexOf(current)
        data.value.events[index] = clone(frozenEvent)
      } else {
        data.value.events.push(clone(frozenEvent))
      }
      propertiesRestored += frozenEvent.properties.filter(
        (property) => !property.deletedAt && !activeBefore.has(property.id),
      ).length
    })

    // 恢复下游依赖的状态与字段引用
    freeze.dependencies.forEach((frozenDependency) => {
      const current = data.value.dependencies.find((item) => item.id === frozenDependency.id)
      if (current) {
        Object.assign(current, {
          name: frozenDependency.name,
          type: frozenDependency.type,
          owner: frozenDependency.owner,
          environment: frozenDependency.environment,
          eventIds: clone(frozenDependency.eventIds),
          propertyRefs: clone(frozenDependency.propertyRefs),
          status: frozenDependency.status,
        })
      } else {
        data.value.dependencies.push(clone(frozenDependency))
      }
    })

    // 撤销本次发布写入的基线
    const revoked = (release.publishedBaselineIds ?? []).filter((baselineId) => {
      const index = data.value.baselines.findIndex((item) => item.id === baselineId)
      if (index < 0) return false
      data.value.baselines.splice(index, 1)
      return true
    }).length

    release.status = 'rolled_back'
    release.publishedAt = undefined
    data.value.currentVersion = freeze.previousVersion

    const record: RollbackRecord = {
      id: createId('rollback'),
      releaseId,
      version: release.version,
      reason,
      operator: '当前用户',
      scope,
      createdAt: new Date().toISOString(),
      status: 'executed',
      evidence,
      restoreSummary: {
        eventsRestored: freeze.events.length,
        propertiesRestored,
        dependenciesRestored: freeze.dependencies.length,
        baselinesRevoked: revoked,
      },
    }
    data.value.rollbacks.unshift(record)
    appendTimeline(
      release,
      'rolled_back',
      '当前用户',
      `按冻结内容回滚：恢复 ${freeze.events.length} 个事件、${propertiesRestored} 个字段、${freeze.dependencies.length} 个依赖，撤销 ${revoked} 个基线。原因：${reason}`,
    )
    audit(
      'rollback',
      record.id,
      '执行回滚',
      `${release.version}：恢复事件/属性/依赖至冻结状态，${reason}`,
    )
    persist()
    return record
  }

  const verifyRollback = (rollbackId: string, evidence: string): void => {
    const record = data.value.rollbacks.find((item) => item.id === rollbackId)
    if (!record) return
    record.status = 'verified'
    record.evidence = evidence
    const release = data.value.releases.find((item) => item.id === record.releaseId)
    if (release) appendTimeline(release, 'rollback_verified', '当前用户', evidence)
    audit('rollback', record.id, '验证回滚', evidence)
    persist()
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
    refreshReleaseBlockers,
    blockersFor,
    restoreFrozenProperty,
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
