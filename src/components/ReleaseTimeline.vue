<script setup lang="ts">
import type { ReleaseTimelineEntry } from '@/models/domain'
import StatusTag from '@/components/StatusTag.vue'

defineProps<{
  timeline: ReleaseTimelineEntry[]
}>()

const formatTime = (value: string): string => new Date(value).toLocaleString('zh-CN')
</script>

<template>
  <ol class="timeline">
    <li v-for="entry in timeline" :key="entry.id" class="timeline-item">
      <span class="timeline-dot" :data-action="entry.action" />
      <div class="timeline-body">
        <div class="timeline-head">
          <StatusTag :value="entry.action" />
          <strong>{{ entry.actor }}</strong>
          <time>{{ formatTime(entry.createdAt) }}</time>
        </div>
        <p>{{ entry.detail }}</p>
      </div>
    </li>
    <li v-if="timeline.length === 0" class="timeline-empty">暂无流程记录。</li>
  </ol>
</template>

<style scoped>
.timeline {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 14px 18px 18px;
  list-style: none;
}

.timeline-item {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 12px;
  padding-bottom: 18px;
  position: relative;
}

.timeline-item:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 16px;
  bottom: 0;
  width: 1px;
  background: #dfe3e8;
}

.timeline-item:last-child {
  padding-bottom: 0;
}

.timeline-dot {
  width: 10px;
  height: 10px;
  margin-top: 5px;
  border-radius: 50%;
  background: #1264c5;
  z-index: 1;
}

.timeline-dot[data-action='frozen'] {
  background: #1264c5;
}

.timeline-dot[data-action='unblocked'] {
  background: #0f8a62;
}

.timeline-dot[data-action='published'] {
  background: #0f8a62;
}

.timeline-dot[data-action='rolled_back'] {
  background: #b42318;
}

.timeline-dot[data-action='rollback_verified'] {
  background: #0f8a62;
}

.timeline-body {
  display: grid;
  gap: 5px;
}

.timeline-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.timeline-head strong {
  font-size: 12px;
}

.timeline-head time {
  margin-left: auto;
  color: #8a93a3;
  font-size: 11px;
}

.timeline-body p {
  margin: 0;
  color: #596579;
  font-size: 12px;
  line-height: 1.6;
}

.timeline-empty {
  color: #8a93a3;
  font-size: 12px;
  list-style: none;
}
</style>
