<template>
  <div class="not-found">
    <div class="nf-icon">🔍</div>
    <h2>页面不存在</h2>
    <p>您访问的页面不存在或已被移动</p>
    <router-link to="/" class="btn btn-primary">返回智能顾问</router-link>
  </div>
</template>

<script setup>
</script>

<style scoped>
.not-found {
  max-width: 420px;
  margin: 80px auto;
  text-align: center;
  padding: 40px 24px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.nf-icon {
  font-size: 48px;
  margin-bottom: 12px;
}
.not-found h2 {
  margin: 0 0 8px;
  color: var(--text-title);
  font-size: 20px;
}
.not-found p {
  margin: 0 0 24px;
  color: var(--text-secondary);
  font-size: 14px;
}
</style>
