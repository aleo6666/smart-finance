<template>
  <div class="chat-container">
    <div class="chat-messages" ref="messagesEl">
      <div v-if="store.messages.length === 0" class="empty-state">
        <div class="empty-icon">💬</div>
        <p>开始记账吧！告诉我你今天花了多少钱~</p>
        <div class="quick-actions" style="justify-content: center; margin-top: 16px;">
          <span class="quick-action" @click="send('今天午餐花了25元')">🍜 午餐25元</span>
          <span class="quick-action" @click="send('打车上班花了30元')">🚕 打车30元</span>
          <span class="quick-action" @click="send('我这个月花了多少钱')">📊 本月汇总</span>
          <span class="quick-action" @click="send('帮我分析一下消费')">🔍 消费分析</span>
        </div>
      </div>

      <MessageBubble v-for="(msg, i) in store.messages" :key="i" :msg="msg" />

      <div v-if="store.loading" class="message assistant">
        <div class="avatar">🤖</div>
        <div class="bubble" style="color: var(--text-secondary);">思考中...</div>
      </div>
    </div>

    <div class="chat-input-area">
      <div class="chat-input-wrapper">
        <textarea
          v-model="input"
          @keydown.enter.exact.prevent="send()"
          placeholder="输入消费记录或问题，如：今天午餐花了25元..."
          rows="1"
          ref="inputEl"
          :disabled="store.loading"
        ></textarea>
        <button @click="send()" :disabled="!input.trim() || store.loading">↑</button>
      </div>
      <div class="quick-actions">
        <span class="quick-action" @click="send('今天午餐花了25元')">🍜 记账</span>
        <span class="quick-action" @click="send('这个月花了多少钱')">📊 本月</span>
        <span class="quick-action" @click="send('有什么省钱建议吗')">💡 建议</span>
        <span class="quick-action" @click="send('我想存钱买一个新手机')">🎯 设目标</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted } from 'vue'
import { useAppStore } from '../stores/app.js'
import MessageBubble from './MessageBubble.vue'

const store = useAppStore()
const input = ref('')
const messagesEl = ref(null)
const inputEl = ref(null)

async function send(text) {
  const msg = text || input.value.trim()
  if (!msg) return
  input.value = ''

  await store.sendMessage(msg)
  await nextTick()
  if (messagesEl.value) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  }
}

onMounted(() => {
  inputEl.value?.focus()
})
</script>
