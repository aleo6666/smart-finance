<template>
  <div class="support-overlay" v-if="show" @click.self="$emit('close')">
    <div class="support-modal">
      <button class="close-btn" @click="$emit('close')" aria-label="关闭">✕</button>

      <div class="support-head">
        <div class="coffee-icon">☕</div>
        <h2>如果你觉得有帮助</h2>
        <p class="support-sub">
          这个账本管家在帮你省钱、看清每一笔钱。<br />
          如果它让你少操了一点心，可以请我喝杯奶茶，<br />
          支持我把它做得更好。
        </p>
      </div>

      <div class="qr-wrap">
        <img src="/support-qr.jpg" alt="微信支付收款码" class="qr-img" />
        <div class="qr-tip">
          <span class="wechat-logo">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </span>
          微信扫一扫 · 请我喝杯奶茶
        </div>
      </div>

      <p class="support-foot">
        支持与否不影响任何功能 —— 你的使用，就是最好的支持
      </p>
    </div>
  </div>
</template>

<script setup>
defineProps({ show: { type: Boolean, default: false } })
defineEmits(['close'])
</script>

<style scoped>
.support-overlay {
  position: fixed;
  inset: 0;
  background: rgba(6, 27, 49, 0.45);
  backdrop-filter: blur(4px);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.support-modal {
  position: relative;
  width: 340px;
  max-width: 92vw;
  background: #fff;
  border-radius: 20px;
  padding: 32px 28px 24px;
  box-shadow: 0 20px 60px rgba(6, 27, 49, 0.25);
  text-align: center;
  animation: support-in 0.25s ease;
}
@keyframes support-in {
  from { opacity: 0; transform: translateY(12px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.close-btn {
  position: absolute;
  top: 12px;
  right: 14px;
  border: none;
  background: none;
  font-size: 15px;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px;
  line-height: 1;
}
.close-btn:hover { color: #533afd; }
.coffee-icon {
  font-size: 34px;
  line-height: 1;
  margin-bottom: 10px;
}
.support-head h2 {
  font-size: 18px;
  font-weight: 700;
  color: #061b31;
  margin: 0 0 10px;
}
.support-sub {
  font-size: 13px;
  color: #64748b;
  line-height: 1.8;
  margin: 0 0 18px;
}
.qr-wrap {
  background: #f6f9fc;
  border: 1px solid #e5edf5;
  border-radius: 16px;
  padding: 16px;
}
.qr-img {
  width: 200px;
  height: 200px;
  border-radius: 10px;
  display: block;
  margin: 0 auto;
}
.qr-tip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  color: #475569;
  margin-top: 10px;
}
.wechat-logo {
  display: inline-flex;
  color: #07c160;
}
.support-foot {
  font-size: 12px;
  color: #94a3b8;
  margin: 14px 0 0;
  line-height: 1.6;
}
</style>
