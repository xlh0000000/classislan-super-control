<script setup lang="ts">
// 贡献者：威廉
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
/* RhineLab 式提示：底部居中深橄榄条、浅字、300ms 上浮淡入。 */
.toast-host{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);z-index:400;display:grid;justify-items:center;gap:10px;width:min(560px,calc(100vw - 36px));pointer-events:none}
.toast{pointer-events:auto;display:flex;align-items:center;gap:16px;padding:15px 20px 15px 27px;background:var(--fill);color:var(--fill-ink);border-left:3px solid var(--accent);font-size:14px}
.toast[data-kind="ok"]{border-left-color:var(--good)}
.toast[data-kind="err"]{border-left-color:var(--bad)}
.toast span{flex:1}
.toast button{width:26px;height:26px;flex:none;border:0;background:none;color:inherit;opacity:.7;cursor:pointer;font-size:14px;line-height:1}
.toast button:hover{opacity:1}
.toast-enter-active,.toast-leave-active{transition:opacity 300ms var(--ease-enter,ease),transform 300ms var(--ease-enter,ease)}
.toast-enter-from,.toast-leave-to{opacity:0;transform:translateY(15px)}
</style>
