<script setup lang="ts">
const { toasts, dismiss } = useToast();
</script>

<template>
  <Teleport to="body">
    <div class="toast-host" role="status" aria-live="polite">
      <TransitionGroup name="toast">
        <article v-for="toast in toasts" :key="toast.id" class="toast" :data-kind="toast.kind">
          <span>{{ toast.text }}</span>
          <button type="button" aria-label="关闭提示" @click="dismiss(toast.id)">×</button>
        </article>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-host{position:fixed;top:18px;right:18px;z-index:400;display:grid;gap:10px;width:min(380px,calc(100vw - 36px));pointer-events:none}
.toast{pointer-events:auto;display:flex;align-items:start;gap:12px;padding:14px 12px 14px 16px;border-radius:var(--radius-row);background:var(--surface-glass,var(--surface-1));backdrop-filter:blur(18px);box-shadow:0 18px 40px rgb(0 0 0/.16);border-left:3px solid var(--ink-muted);color:var(--ink);font-size:12px;line-height:1.5}
.toast[data-kind="ok"]{border-left-color:var(--good)}
.toast[data-kind="err"]{border-left-color:var(--bad)}
.toast span{flex:1}
.toast button{width:28px;height:28px;flex:none;border:0;border-radius:8px;background:var(--surface-2);color:var(--ink-soft);cursor:pointer;font-size:12px;line-height:1}
.toast-enter-active,.toast-leave-active{transition:opacity 180ms var(--ease-enter,ease),transform 180ms var(--ease-enter,ease)}
.toast-enter-from,.toast-leave-to{opacity:0;transform:translateY(-6px) scale(.98)}
</style>