<template>
  <div class="message" :class="msg.role">
    <div class="avatar">{{ msg.role === 'user' ? '😊' : '🤖' }}</div>
    <div>
      <div class="bubble" v-html="renderedContent"></div>
      <div class="time">{{ formatTime(msg.time) }}</div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  msg: { type: Object, required: true }
})

const renderedContent = computed(() => {
  return props.msg.content.replace(/\n/g, '<br>')
})

function formatTime(date) {
  if (!date) return ''
  const d = new Date(date)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
</script>
