<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  CheckCircleIcon,
  FileSearchIcon,
  HistoryIcon,
  RollbackIcon,
} from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import ReleaseTimeline from '@/components/ReleaseTimeline.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const queryClient = useQueryClient()
const rollbackVisible = ref(false)
const verifyVisible = ref(false)
const selectedRollbackId = ref('')
const form = reactive({
  releaseId: '',
  reason: '',
  scope: '',
  evidence: '',
})
const verifyForm = reactive({
  evidence: '',
})

// 回滚目标只能是已发布、且带冻结快照的候选
const rollbackableReleases = computed(() =>
  store.data.releases.filter((release) => release.status === 'published'),
)

const rollbackRecords = computed(() =>
  store.data.rollbacks.map((record) => ({
    ...record,
    release: store.data.releases.find((release) => release.id === record.releaseId),
  })),
)

const invalidate = async (): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: ['releases'] })
  await queryClient.invalidateQueries({ queryKey: ['release'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  await queryClient.invalidateQueries({ queryKey: ['validations'] })
  await queryClient.invalidateQueries({ queryKey: ['lineage'] })
}

const openRollback = (): void => {
  form.releaseId = rollbackableReleases.value[0]?.id ?? ''
  form.reason = ''
  form.scope = ''
  form.evidence = ''
  rollbackVisible.value = true
}

const execute = async (): Promise<void> => {
  if (!form.releaseId || !form.reason.trim() || !form.scope.trim() || !form.evidence.trim()) {
    await MessagePlugin.error('版本、回滚原因、影响范围和证据编号不能为空')
    return
  }
  const target = store.data.releases.find((release) => release.id === form.releaseId)
  if (target?.status !== 'published') {
    await MessagePlugin.error('只能回滚已发布的候选版本')
    return
  }
  if (!target.freeze) {
    await MessagePlugin.error('该候选没有冻结快照，无法按冻结内容恢复事件、属性与依赖')
    return
  }
  const result = store.executeRollback(form.releaseId, form.reason, form.scope, form.evidence)
  if (!result.ok) {
    await MessagePlugin.error(
      result.reason === 'not_published'
        ? '只能回滚已发布的候选版本'
        : '该候选缺少冻结快照，无法恢复契约状态',
    )
    return
  }
  rollbackVisible.value = false
  await invalidate()
  await MessagePlugin.success(
    `已按冻结快照恢复 ${result.record.restoredEventCount ?? 0} 个事件、${result.record.restoredDependencyCount ?? 0} 个依赖，请继续执行结果验证`,
  )
}

const openVerify = (rollbackId: string): void => {
  selectedRollbackId.value = rollbackId
  verifyForm.evidence = ''
  verifyVisible.value = true
}

const verify = async (): Promise<void> => {
  if (!verifyForm.evidence.trim()) {
    await MessagePlugin.error('验证证据不能为空')
    return
  }
  const ok = store.verifyRollback(selectedRollbackId.value, verifyForm.evidence)
  if (!ok) {
    await MessagePlugin.error('回滚记录状态不可验证')
    return
  }
  verifyVisible.value = false
  await invalidate()
  await MessagePlugin.success('回滚验证结果已记录，时间线已更新')
}

const formatTime = (value?: string): string => (value ? new Date(value).toLocaleString('zh-CN') : '—')
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="故障恢复"
      title="回滚与验证记录"
      description="按候选冻结快照恢复事件、属性与下游依赖状态，回滚不是只改版本号；发布与回滚经过均写入时间线。"
    />

    <section class="panel filter-panel">
      <div class="toolbar-row">
        <div>
          <strong>发布回滚台账</strong>
          <p class="page-description">回滚按冻结内容恢复事件状态、属性（含下线字段标记）、依赖状态与引用，并移除本次发布基线。</p>
        </div>
        <div class="filter-actions">
          <t-button theme="danger" :disabled="rollbackableReleases.length === 0" @click="openRollback">
            <template #icon><RollbackIcon /></template>
            执行回滚
          </t-button>
        </div>
      </div>
    </section>

    <div v-if="rollbackableReleases.length > 0" class="panel rollback-targets">
      <span>可回滚的已发布候选：</span>
      <template v-for="release in rollbackableReleases" :key="release.id">
        <StatusTag :value="release.version" />
        <strong>{{ release.title }}</strong>
        <span class="muted">冻结于 {{ formatTime(release.freeze?.frozenAt) }}</span>
      </template>
    </div>

    <div class="rollback-summary">
      <div>
        <HistoryIcon />
        <span>回滚记录</span>
        <strong>{{ rollbackRecords.length }}</strong>
      </div>
      <div>
        <CheckCircleIcon />
        <span>已验证</span>
        <strong>{{ rollbackRecords.filter((record) => record.status === 'verified').length }}</strong>
      </div>
      <div>
        <FileSearchIcon />
        <span>待验证</span>
        <strong>{{ rollbackRecords.filter((record) => record.status === 'executed').length }}</strong>
      </div>
    </div>

    <section class="panel">
      <div class="panel-header">
        <h2 class="panel-title">回滚记录</h2>
      </div>
      <div class="rollback-list">
        <article v-for="record in rollbackRecords" :key="record.id" class="rollback-item">
          <div class="rollback-icon">
            <RollbackIcon />
          </div>
          <div class="rollback-main">
            <div class="rollback-head">
              <div>
                <strong>{{ record.version }}</strong>
                <span>{{ record.release?.title ?? '历史发布版本' }}</span>
              </div>
              <StatusTag :value="record.status" />
            </div>
            <p>{{ record.reason }}</p>
            <dl>
              <div>
                <dt>影响范围</dt>
                <dd>{{ record.scope }}</dd>
              </div>
              <div>
                <dt>操作人</dt>
                <dd>{{ record.operator }}</dd>
              </div>
              <div>
                <dt>执行时间</dt>
                <dd>{{ new Date(record.createdAt).toLocaleString('zh-CN') }}</dd>
              </div>
              <div>
                <dt>冻结快照时间</dt>
                <dd>{{ formatTime(record.frozenAt) }}</dd>
              </div>
              <div>
                <dt>恢复事件 / 依赖</dt>
                <dd>{{ record.restoredEventCount ?? '—' }} / {{ record.restoredDependencyCount ?? '—' }}</dd>
              </div>
              <div>
                <dt>移除发布基线</dt>
                <dd>{{ record.removedBaselineCount ?? '—' }} 条</dd>
              </div>
              <div>
                <dt>验证证据</dt>
                <dd>{{ record.evidence }}</dd>
              </div>
            </dl>
            <t-button
              v-if="record.status === 'executed'"
              theme="primary"
              variant="outline"
              size="small"
              @click="openVerify(record.id)"
            >
              记录验证结果
            </t-button>
            <section v-if="record.release?.timeline?.length" class="record-timeline">
              <h4>该候选发布 / 回滚时间线</h4>
              <ReleaseTimeline :timeline="record.release.timeline" />
            </section>
          </div>
        </article>
        <div v-if="rollbackRecords.length === 0" class="empty-state">暂无回滚记录。</div>
      </div>
    </section>

    <t-dialog v-model:visible="rollbackVisible" header="执行契约回滚" width="680px" :footer="false">
      <div class="editor-form">
        <div class="field field-wide">
          <label>回滚目标版本（仅限已发布候选）</label>
          <t-select
            v-model="form.releaseId"
            :options="
              rollbackableReleases.map((release) => ({
                label: `${release.version} ${release.title}（冻结于 ${formatTime(release.freeze?.frozenAt)}）`,
                value: release.id,
              }))
            "
          />
          <p v-if="form.releaseId" class="rollback-note">
            将恢复 {{ store.data.releases.find((r) => r.id === form.releaseId)?.freeze?.events.length ?? 0 }}
            个事件、{{ store.data.releases.find((r) => r.id === form.releaseId)?.freeze?.dependencies.length ?? 0 }}
            个下游依赖到冻结时状态，并移除本次发布写入的基线。
          </p>
        </div>
        <div class="field field-wide">
          <label>回滚原因</label>
          <t-textarea v-model="form.reason" :autosize="{ minRows: 3, maxRows: 5 }" />
        </div>
        <div class="field field-wide">
          <label>影响范围</label>
          <t-textarea v-model="form.scope" :autosize="{ minRows: 3, maxRows: 5 }" />
        </div>
        <div class="field field-wide">
          <label>执行证据编号</label>
          <t-input v-model="form.evidence" />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="rollbackVisible = false">取消</t-button>
        <t-button theme="danger" @click="execute">确认执行</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="verifyVisible" header="记录回滚验证" width="600px" :footer="false">
      <div class="field">
        <label>验证证据</label>
        <t-textarea
          v-model="verifyForm.evidence"
          :autosize="{ minRows: 5, maxRows: 8 }"
          placeholder="填写指标恢复、客户端行为、工单或监控证据"
        />
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="verifyVisible = false">取消</t-button>
        <t-button theme="primary" @click="verify">确认验证</t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.filter-panel {
  padding: 14px 16px;
}

.rollback-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #dfe3e8;
}

.rollback-targets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  padding: 12px 16px;
}

.rollback-targets span {
  color: #596579;
  font-size: 12px;
}

.rollback-targets strong {
  font-size: 12px;
}

.rollback-note {
  margin: 8px 0 0;
  color: #b65300;
  font-size: 12px;
  line-height: 1.6;
}

.record-timeline {
  margin-top: 6px;
  border: 1px solid #edf0f3;
  border-radius: 6px;
  background: #fafbfc;
}

.record-timeline h4 {
  margin: 0;
  padding: 12px 18px 0;
  font-size: 12px;
  color: #49566b;
}

.rollback-summary > div {
  display: grid;
  grid-template-columns: 30px 1fr auto;
  align-items: center;
  gap: 9px;
  padding: 15px 16px;
  background: #fff;
}

.rollback-summary svg {
  color: #1264c5;
}

.rollback-summary span {
  color: #717c8e;
  font-size: 12px;
}

.rollback-summary strong {
  font-size: 22px;
}

.rollback-list {
  display: grid;
}

.rollback-item {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 14px;
  padding: 18px;
  border-bottom: 1px solid #e8ebef;
}

.rollback-item:last-child {
  border-bottom: 0;
}

.rollback-icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 6px;
  color: #b42318;
  background: #fff2f0;
}

.rollback-main {
  display: grid;
  gap: 12px;
}

.rollback-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.rollback-head > div {
  display: grid;
  gap: 4px;
}

.rollback-head span {
  color: #737e90;
  font-size: 11px;
}

.rollback-main > p {
  margin: 0;
  color: #596579;
  font-size: 13px;
}

.rollback-main dl {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
}

.rollback-main dl > div {
  display: grid;
  gap: 5px;
}

.rollback-main dt {
  color: #788295;
  font-size: 10px;
}

.rollback-main dd {
  margin: 0;
  font-size: 11px;
}

.rollback-main :deep(.t-button) {
  justify-self: start;
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
