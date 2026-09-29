<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  AddIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CloseCircleIcon,
  DownloadIcon,
  HistoryIcon,
  LockOnIcon,
} from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useReleaseQuery, useReleasesQuery } from '@/composables/useGovernanceQueries'
import type { ReleaseApproval, ReleaseBlocker, ReleaseTimelineEntry } from '@/models/domain'
import { releaseReadiness } from '@/services/selectors'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const queryClient = useQueryClient()
const releasesQuery = useReleasesQuery()
const releaseId = ref(
  store.data.releases.find((release) => release.status === 'blocked' || release.status === 'reviewing')
    ?.id ??
    store.data.releases[0]?.id ??
    '',
)
const releaseQuery = useReleaseQuery(releaseId)
const release = computed(
  () =>
    releaseQuery.data.value ??
    store.data.releases.find((item) => item.id === releaseId.value) ??
    null,
)
const releases = computed(() => releasesQuery.data.value ?? store.data.releases)
const blockers = computed<ReleaseBlocker[]>(() => release.value?.blockers ?? [])
const isBlocked = computed(() => release.value?.status === 'blocked' && blockers.value.length > 0)
const readiness = computed(() => (release.value ? releaseReadiness(release.value, store.issues) : 0))

const createVisible = ref(false)
const migrationVisible = ref(false)
const approvalVisible = ref(false)
const createForm = reactive({
  version: '',
  title: '',
  eventIds: [] as string[],
})
const migrationForm = reactive({
  confirmationId: '',
  reviewer: '',
  note: '',
})
const selectedApprovalIds = ref<string[]>([])
const approvalComment = ref('')
const singleApproval = ref<ReleaseApproval | null>(null)

const eventName = (eventId: string): string => {
  const event = store.data.events.find((item) => item.id === eventId)
  return event ? `${event.displayName} (${event.key})` : eventId
}
const dependencyName = (dependencyId: string): string =>
  store.data.dependencies.find((dependency) => dependency.id === dependencyId)?.name ?? dependencyId
const roleLabel = (role: ReleaseApproval['role']): string =>
  ({ data: '数据负责人', product: '产品负责人', client: '客户端负责人', qa: '测试负责人' })[role]

const phaseMeta: Record<
  ReleaseTimelineEntry['phase'],
  { label: string; tone: 'success' | 'warning' | 'danger' | 'default' | 'primary' }
> = {
  created: { label: '创建候选', tone: 'primary' },
  blocked: { label: '进入待处理', tone: 'danger' },
  unblocked: { label: '阻断解除', tone: 'success' },
  migration_confirmed: { label: '迁移确认', tone: 'primary' },
  approved: { label: '审批通过', tone: 'success' },
  rejected: { label: '审批驳回', tone: 'danger' },
  published: { label: '发布', tone: 'success' },
  rolled_back: { label: '回滚', tone: 'warning' },
  rollback_verified: { label: '回滚验证', tone: 'success' },
  property_restored: { label: '恢复字段', tone: 'warning' },
}

const invalidate = async (): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: ['release'] })
  await queryClient.invalidateQueries({ queryKey: ['releases'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  await queryClient.invalidateQueries({ queryKey: ['lineage'] })
  await queryClient.invalidateQueries({ queryKey: ['validations'] })
}

const openCreate = (): void => {
  createForm.version = `2026.${String(Number(store.data.currentVersion.split('.')[1] ?? 10) + 1).padStart(2, '0')}.0`
  createForm.title = ''
  createForm.eventIds = []
  createVisible.value = true
}

const createRelease = async (): Promise<void> => {
  if (!createForm.version.trim() || !createForm.title.trim() || createForm.eventIds.length === 0) {
    await MessagePlugin.error('版本号、标题和事件范围不能为空')
    return
  }
  const created = store.createRelease(createForm.version, createForm.title, createForm.eventIds)
  releaseId.value = created.id
  createVisible.value = false
  await invalidate()
  if (created.blockers.length > 0) {
    await MessagePlugin.warning(`候选已冻结并停在待处理区，存在 ${created.blockers.length} 个阻断项`)
  } else {
    await MessagePlugin.success('发布候选已创建并完成冻结，可进入迁移确认与审批')
  }
}

const openMigration = (confirmationId: string): void => {
  const confirmation = release.value?.migrationConfirmations.find(
    (item) => item.id === confirmationId,
  )
  if (!confirmation) return
  migrationForm.confirmationId = confirmationId
  migrationForm.reviewer = confirmation.reviewer
  migrationForm.note = confirmation.note
  migrationVisible.value = true
}

const confirmMigration = async (): Promise<void> => {
  if (!release.value || !migrationForm.reviewer.trim() || !migrationForm.note.trim()) {
    await MessagePlugin.error('确认人和迁移说明不能为空')
    return
  }
  store.confirmMigration(
    release.value.id,
    migrationForm.confirmationId,
    migrationForm.reviewer,
    migrationForm.note,
  )
  migrationVisible.value = false
  await invalidate()
  await MessagePlugin.success('下游迁移已确认，旧字段引用已从依赖中移除')
}

const openApproval = (approval: ReleaseApproval): void => {
  if (isBlocked.value) {
    void MessagePlugin.warning('待处理区阻断项未解决，暂不可审批')
    return
  }
  singleApproval.value = approval
  approvalComment.value = approval.comment
  approvalVisible.value = true
}

const submitApproval = async (status: ReleaseApproval['status']): Promise<void> => {
  if (!release.value || !singleApproval.value || !approvalComment.value.trim()) {
    await MessagePlugin.error('审批意见不能为空')
    return
  }
  const ok = store.updateApproval(
    release.value.id,
    singleApproval.value.role,
    status,
    singleApproval.value.actor,
    approvalComment.value,
  )
  if (!ok) {
    await MessagePlugin.error('待处理区阻断项未解决，审批未提交')
    return
  }
  approvalVisible.value = false
  await invalidate()
  await MessagePlugin.success(status === 'approved' ? '审批已通过' : '审批已驳回')
}

const batchApprove = async (): Promise<void> => {
  if (!release.value) return
  if (isBlocked.value) {
    await MessagePlugin.error('待处理区阻断项未解决，批量审批已拦截')
    return
  }
  if (selectedApprovalIds.value.length === 0 || !approvalComment.value.trim()) {
    await MessagePlugin.error('请选择审批项并填写批量审批意见')
    return
  }
  let rejected = 0
  selectedApprovalIds.value.forEach((id) => {
    const approval = release.value?.approvals.find((item) => item.id === id)
    if (approval) {
      const ok = store.updateApproval(
        release.value!.id,
        approval.role,
        'approved',
        approval.actor,
        approvalComment.value,
      )
      if (!ok) rejected += 1
    }
  })
  selectedApprovalIds.value = []
  approvalComment.value = ''
  await invalidate()
  if (rejected > 0) await MessagePlugin.warning(`${rejected} 项审批因阻断未解除被拦截`)
  else await MessagePlugin.success('批量审批已提交')
}

const publish = async (): Promise<void> => {
  if (!release.value) return
  if (isBlocked.value) {
    await MessagePlugin.error(`待处理区仍有 ${blockers.value.length} 个阻断项，发布门禁未放行`)
    return
  }
  const error = store.publishRelease(release.value.id)
  if (error) {
    await MessagePlugin.error(error)
    return
  }
  await invalidate()
  await MessagePlugin.success('事件契约版本已发布，冻结快照与发布经过已写入时间线')
}

const restoreProperty = async (blocker: ReleaseBlocker): Promise<void> => {
  if (!release.value) return
  const ok = store.restoreFrozenProperty(release.value.id, blocker.id)
  await invalidate()
  if (ok) await MessagePlugin.success(`已按冻结快照恢复字段 ${blocker.propertyName ?? ''}`)
  else await MessagePlugin.error('冻结快照中不存在该字段，无法恢复')
}

const downloadDiff = (): void => {
  if (!release.value) return
  const content = JSON.stringify(
    {
      release: release.value.version,
      frozenAt: release.value.freeze?.frozenAt,
      events: release.value.eventIds.map(eventName),
      differences: release.value.differences,
      affectedDependencies: release.value.affectedDependencyIds.map(dependencyName),
      blockers: release.value.blockers,
      migrationConfirmations: release.value.migrationConfirmations,
    },
    null,
    2,
  )
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${release.value.version}-contract-diff.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

const setApprovalChecked = (approvalId: string, checked: unknown): void => {
  selectedApprovalIds.value = checked
    ? [...selectedApprovalIds.value, approvalId]
    : selectedApprovalIds.value.filter((id) => id !== approvalId)
}
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="发布门禁"
      title="版本差异与发布评审"
      description="比较发布候选契约，生成受影响依赖，要求迁移确认并完成数据、产品、客户端和测试四角色审批。"
    />

    <section class="panel filter-panel">
      <div class="toolbar-row">
        <div class="toolbar-field release-field">
          <span>发布候选</span>
          <t-select
            v-model="releaseId"
            :options="releases.map((item) => ({ label: `${item.version} ${item.title}`, value: item.id }))"
          />
        </div>
        <div class="filter-actions">
          <t-button variant="outline" :disabled="!release" @click="downloadDiff">
            <template #icon><DownloadIcon /></template>
            导出差异
          </t-button>
          <t-button theme="primary" @click="openCreate">
            <template #icon><AddIcon /></template>
            创建发布候选
          </t-button>
        </div>
      </div>
    </section>

    <template v-if="release">
      <section v-if="isBlocked" class="panel blocker-panel">
        <div class="blocker-header">
          <div class="blocker-title">
            <LockOnIcon />
            <div>
              <h2>待处理区 · {{ blockers.length }} 个发布阻断</h2>
              <p>
                旧字段引用或严重校验未解除，候选不能审批与发布。请按下方依赖与字段完成迁移或恢复，阻断解除后自动回到评审中。
              </p>
            </div>
          </div>
          <StatusTag value="blocked" />
        </div>
        <div class="blocker-list">
          <article v-for="blocker in blockers" :key="blocker.id" class="blocker-item">
            <div class="blocker-main">
              <div class="blocker-head">
                <StatusTag :value="blocker.severity" />
                <StatusTag :value="blocker.kind" />
                <strong>{{ blocker.title }}</strong>
              </div>
              <p>{{ blocker.detail }}</p>
              <div class="blocker-meta">
                <span v-if="blocker.eventId">
                  事件：<RouterLink to="/events">{{ eventName(blocker.eventId) }}</RouterLink>
                </span>
                <span v-if="blocker.propertyName">字段：<code>{{ blocker.propertyName }}</code></span>
                <span v-for="dependencyId in blocker.dependencyIds" :key="dependencyId">
                  下游依赖：{{ dependencyName(dependencyId) }}
                </span>
              </div>
              <small>{{ blocker.suggestion }}</small>
            </div>
            <div class="blocker-actions">
              <t-button
                v-if="blocker.resolvableByRestore"
                theme="warning"
                variant="outline"
                size="small"
                @click="restoreProperty(blocker)"
              >
                按冻结内容恢复字段
              </t-button>
              <t-button
                v-for="dependencyId in blocker.dependencyIds"
                :key="`mig-${dependencyId}`"
                variant="text"
                size="small"
                :disabled="
                  !release.migrationConfirmations.some(
                    (item) =>
                      item.dependencyId === dependencyId && item.status !== 'confirmed',
                  )
                "
                @click="
                  openMigration(
                    release.migrationConfirmations.find(
                      (item) => item.dependencyId === dependencyId,
                    )?.id ?? '',
                  )
                "
              >
                处理 {{ dependencyName(dependencyId) }} 迁移
              </t-button>
            </div>
          </article>
        </div>
      </section>

      <section class="release-overview">
        <div>
          <span>版本</span>
          <strong>{{ release.version }}</strong>
          <StatusTag :value="release.status" />
        </div>
        <div>
          <span>标题</span>
          <strong>{{ release.title }}</strong>
        </div>
        <div>
          <span>事件范围 / 冻结时间</span>
          <strong>{{ release.eventIds.length }} 个</strong>
          <em v-if="release.freeze" class="muted">
            {{ new Date(release.freeze.frozenAt).toLocaleString('zh-CN') }}
          </em>
        </div>
        <div>
          <span>发布就绪度</span>
          <strong>{{ readiness }}%</strong>
        </div>
        <t-button
          theme="primary"
          :disabled="
            release.status === 'published' ||
            release.status === 'rolled_back' ||
            isBlocked
          "
          @click="publish"
        >
          {{ isBlocked ? '阻断未解除' : '发布契约' }}
          <template #suffix><ChevronRightIcon /></template>
        </t-button>
      </section>

      <div class="release-grid">
        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">契约差异</h2>
            <span class="muted">{{ release.differences.length }} 个事件发生变化</span>
          </div>
          <div class="diff-list">
            <article v-for="difference in release.differences" :key="difference.eventId" class="diff-event">
              <div class="diff-event-head">
                <strong>{{ difference.eventKey }}</strong>
                <span>{{ eventName(difference.eventId) }}</span>
              </div>
              <div class="diff-columns">
                <div class="diff-block">
                  <h4>新增与删除</h4>
                  <ul>
                    <li v-for="item in difference.addedProperties" :key="`add-${item}`">
                      新增属性 {{ item }}
                    </li>
                    <li v-for="item in difference.removedProperties" :key="`remove-${item}`">
                      删除属性 {{ item }}
                    </li>
                  </ul>
                  <span
                    v-if="
                      difference.addedProperties.length === 0 &&
                      difference.removedProperties.length === 0
                    "
                    class="muted"
                  >
                    无属性增删
                  </span>
                </div>
                <div class="diff-block">
                  <h4>兼容性变化</h4>
                  <ul>
                    <li v-for="item in difference.requiredChanges" :key="item">{{ item }}</li>
                    <li v-for="item in difference.typeChanges" :key="item">{{ item }}</li>
                    <li v-for="item in difference.enumChanges" :key="item">{{ item }}</li>
                  </ul>
                  <span
                    v-if="
                      difference.requiredChanges.length === 0 &&
                      difference.typeChanges.length === 0 &&
                      difference.enumChanges.length === 0
                    "
                    class="muted"
                  >
                    无破坏性变化
                  </span>
                </div>
              </div>
            </article>
            <div v-if="release.differences.length === 0" class="empty-state">该版本没有契约差异。</div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">发布门禁</h2>
          </div>
          <div class="gate-list">
            <div class="gate-row">
              <CheckCircleIcon />
              <div>
                <strong>候选冻结已生成</strong>
                <span>
                  {{ release.freeze?.events.length ?? 0 }} 个事件、{{
                    release.freeze?.dependencies.length ?? 0
                  }}
                  个依赖已按创建时状态冻结
                </span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon :class="{ pending: blockers.length > 0, blocked: blockers.length > 0 }" />
              <div>
                <strong>旧字段引用与严重校验</strong>
                <span v-if="blockers.length > 0" class="danger-text">
                  {{ blockers.length }} 个阻断项未解决，候选停在待处理区
                </span>
                <span v-else>阻断项已全部解除</span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon />
              <div>
                <strong>契约差异已生成</strong>
                <span>{{ release.differences.length }} 个事件参与比较</span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{
                  pending: release.migrationConfirmations.some((item) => item.status !== 'confirmed'),
                }"
              />
              <div>
                <strong>下游迁移确认</strong>
                <span>
                  {{
                    release.migrationConfirmations.filter((item) => item.status === 'confirmed').length
                  }}/{{ release.migrationConfirmations.length }} 已确认
                </span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{ pending: release.approvals.some((item) => item.status !== 'approved') }"
              />
              <div>
                <strong>四角色批量审批</strong>
                <span>
                  {{ release.approvals.filter((item) => item.status === 'approved').length }}/{{
                    release.approvals.length
                  }}
                  已通过
                </span>
              </div>
            </div>
            <div class="readiness">
              <span>综合就绪度</span>
              <strong>{{ readiness }}%</strong>
              <t-progress :percentage="readiness" :label="false" />
            </div>
          </div>
        </section>
      </div>

      <div class="review-columns">
        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">下游迁移确认</h2>
          </div>
          <div class="migration-list">
            <article
              v-for="confirmation in release.migrationConfirmations"
              :key="confirmation.id"
              class="migration-card"
            >
              <div>
                <strong>{{ dependencyName(confirmation.dependencyId) }}</strong>
                <span>{{ confirmation.reviewer || '未指定确认人' }}</span>
              </div>
              <StatusTag :value="confirmation.status" />
              <p>{{ confirmation.note || '尚未填写迁移确认说明。' }}</p>
              <t-button
                variant="outline"
                size="small"
                :disabled="confirmation.status === 'confirmed'"
                @click="openMigration(confirmation.id)"
              >
                确认迁移
              </t-button>
            </article>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">四角色审批</h2>
          </div>
          <div class="approval-list">
            <label
              v-for="approval in release.approvals"
              :key="approval.id"
              class="approval-row"
              :class="{ 'blocked-row': isBlocked }"
            >
              <t-checkbox
                :value="selectedApprovalIds.includes(approval.id)"
                :disabled="approval.status === 'approved' || isBlocked"
                @change="setApprovalChecked(approval.id, $event)"
              />
              <div>
                <strong>{{ roleLabel(approval.role) }}</strong>
                <span>{{ approval.actor }} · {{ approval.comment || '待填写意见' }}</span>
              </div>
              <StatusTag :value="approval.status" />
              <t-button variant="text" size="small" :disabled="isBlocked" @click.prevent="openApproval(approval)">
                审批
              </t-button>
            </label>
          </div>
          <div class="batch-bar">
            <t-input v-model="approvalComment" placeholder="批量审批意见" />
            <t-button theme="primary" :disabled="isBlocked" @click="batchApprove">批量通过</t-button>
          </div>
        </section>
      </div>

      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">
            <HistoryIcon class="panel-title-icon" />
            发布时间线
          </h2>
          <span class="muted">创建冻结、阻断、迁移确认、审批、发布与回滚经过全部留痕</span>
        </div>
        <t-timeline class="release-timeline">
          <t-timeline-item
            v-for="entry in release.timeline"
            :key="entry.id"
            :dot-color="
              phaseMeta[entry.phase].tone === 'danger'
                ? '#d54941'
                : phaseMeta[entry.phase].tone === 'warning'
                  ? '#c46a00'
                  : phaseMeta[entry.phase].tone === 'success'
                    ? '#0f8a62'
                    : '#1264c5'
            "
          >
            <div class="timeline-row">
              <t-tag size="small" theme="primary" variant="light">{{ phaseMeta[entry.phase].label }}</t-tag>
              <strong>{{ entry.actor }}</strong>
              <span class="muted">{{ new Date(entry.at).toLocaleString('zh-CN') }}</span>
            </div>
            <p>{{ entry.detail }}</p>
          </t-timeline-item>
        </t-timeline>
      </section>
    </template>

    <div v-else class="panel empty-state">暂无发布候选。</div>

    <t-dialog v-model:visible="createVisible" header="创建发布候选" width="720px" :footer="false">
      <div class="editor-form">
        <div class="field">
          <label>版本号</label>
          <t-input v-model="createForm.version" />
        </div>
        <div class="field">
          <label>发布标题</label>
          <t-input v-model="createForm.title" />
        </div>
        <div class="field field-wide">
          <label>参与发布的事件</label>
          <t-select
            v-model="createForm.eventIds"
            :options="
              store.data.events
                .filter((event) => event.status !== 'retired')
                .map((event) => ({
                  label: `${event.displayName} (${event.key})`,
                  value: event.id,
                }))
            "
            multiple
            filterable
          />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="createVisible = false">取消</t-button>
        <t-button theme="primary" @click="createRelease">创建并比较</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="migrationVisible" header="确认下游迁移" width="620px" :footer="false">
      <div class="editor-form">
        <div class="field">
          <label>确认人</label>
          <t-input v-model="migrationForm.reviewer" />
        </div>
        <div class="field field-wide">
          <label>迁移说明</label>
          <t-textarea v-model="migrationForm.note" :autosize="{ minRows: 5, maxRows: 8 }" />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="migrationVisible = false">取消</t-button>
        <t-button theme="primary" @click="confirmMigration">确认迁移</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="approvalVisible" header="提交审批" width="620px" :footer="false">
      <div v-if="singleApproval" class="selected-approval">
        <strong>{{ roleLabel(singleApproval.role) }}</strong>
        <span>{{ singleApproval.actor }}</span>
      </div>
      <div class="field">
        <label>审批意见</label>
        <t-textarea v-model="approvalComment" :autosize="{ minRows: 5, maxRows: 8 }" />
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="approvalVisible = false">取消</t-button>
        <t-button theme="danger" @click="submitApproval('rejected')">
          <template #icon><CloseCircleIcon /></template>
          驳回
        </t-button>
        <t-button theme="primary" @click="submitApproval('approved')">
          <template #icon><CheckCircleIcon /></template>
          通过
        </t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.filter-panel {
  padding: 14px 16px;
}

.blocker-panel {
  border: 1px solid #f0c2be;
  background: #fff8f7;
}

.blocker-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
  border-bottom: 1px solid #f6d9d6;
}

.blocker-title {
  display: flex;
  gap: 12px;
}

.blocker-title svg {
  margin-top: 2px;
  color: #c0392b;
  font-size: 20px;
}

.blocker-title h2 {
  margin: 0 0 6px;
  font-size: 15px;
  color: #a8261d;
}

.blocker-title p {
  margin: 0;
  color: #8a5a55;
  font-size: 12px;
  line-height: 1.6;
}

.blocker-list {
  display: grid;
  gap: 1px;
  background: #f6d9d6;
}

.blocker-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 14px;
  align-items: center;
  padding: 15px 18px;
  background: #fff;
}

.blocker-main {
  display: grid;
  gap: 7px;
}

.blocker-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.blocker-head strong {
  font-size: 13px;
}

.blocker-main p {
  margin: 0;
  color: #5f6b7d;
  font-size: 12px;
}

.blocker-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  color: #737e90;
  font-size: 11px;
}

.blocker-meta code {
  padding: 1px 5px;
  border-radius: 4px;
  background: #f1f3f6;
  font-family: monospace;
}

.blocker-meta a {
  color: #1264c5;
  text-decoration: none;
}

.blocker-main small {
  color: #b45a00;
  font-size: 11px;
}

.blocker-actions {
  display: grid;
  gap: 6px;
  justify-items: end;
}

.danger-text {
  color: #c0392b;
}

.panel-title-icon {
  margin-right: 6px;
  vertical-align: -2px;
}

.release-timeline {
  padding: 18px 22px 8px;
}

.timeline-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.timeline-row span {
  font-size: 11px;
}

.release-timeline :deep(.t-timeline-item__content p) {
  margin: 6px 0 0;
  color: #5f6b7d;
  font-size: 12px;
  line-height: 1.6;
}

.gate-row svg.blocked {
  color: #c0392b;
}

.approval-row.blocked-row {
  opacity: 0.65;
}

.release-field {
  min-width: 390px;
}

.release-overview {
  display: grid;
  grid-template-columns: 180px minmax(260px, 1fr) 130px 140px auto;
  align-items: center;
  gap: 1px;
  overflow: hidden;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #dfe3e8;
}

.release-overview > div,
.release-overview > button {
  align-self: stretch;
}

.release-overview > div {
  display: grid;
  gap: 6px;
  padding: 14px 16px;
  background: #fff;
}

.release-overview span {
  color: #717c8e;
  font-size: 11px;
}

.release-overview > button {
  border-radius: 0;
}

.release-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.55fr);
  gap: 16px;
  align-items: start;
}

.diff-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.diff-event {
  padding: 16px;
  background: #fff;
}

.diff-event-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}

.diff-event-head strong {
  font-family: monospace;
  font-size: 12px;
}

.diff-event-head span {
  color: #737e90;
  font-size: 11px;
}

.gate-list {
  padding: 10px 16px 18px;
}

.gate-row {
  display: grid;
  grid-template-columns: 30px 1fr;
  gap: 10px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid #edf0f3;
}

.gate-row svg {
  color: #0f8a62;
}

.gate-row svg.pending {
  color: #c46a00;
}

.gate-row > div {
  display: grid;
  gap: 4px;
}

.gate-row strong {
  font-size: 12px;
}

.gate-row span,
.readiness span {
  color: #727d8f;
  font-size: 11px;
}

.readiness {
  display: grid;
  gap: 7px;
  padding-top: 16px;
}

.readiness strong {
  font-size: 24px;
}

.review-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.migration-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.migration-card {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 9px;
  padding: 15px 16px;
  background: #fff;
}

.migration-card > div {
  display: grid;
  gap: 4px;
}

.migration-card span,
.migration-card p {
  color: #6d788b;
  font-size: 11px;
}

.migration-card p {
  grid-column: 1 / -1;
  margin: 0;
  line-height: 1.5;
}

.migration-card :deep(.t-button) {
  grid-column: 1 / -1;
  justify-self: start;
}

.approval-list {
  display: grid;
  padding: 6px 16px;
}

.approval-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid #edf0f3;
  cursor: pointer;
}

.approval-row > div {
  display: grid;
  gap: 4px;
}

.approval-row span {
  color: #717c8e;
  font-size: 11px;
}

.batch-bar {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid #e8ebef;
}

.selected-approval {
  display: flex;
  justify-content: space-between;
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #fafbfc;
}

.selected-approval span {
  color: #717c8e;
  font-size: 12px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid #e8ebef;
}
</style>
