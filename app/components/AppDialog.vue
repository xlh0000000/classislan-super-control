<script setup lang="ts">
const props = defineProps<{ title: string; kicker?: string; width?: string; closeOnBackdrop?: boolean }>();
const emit = defineEmits<{ close: [] }>();

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close");
}

onMounted(() => {
  document.addEventListener("keydown", onKeydown);
  document.documentElement.style.overflow = "hidden";
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  document.documentElement.style.overflow = "";
});
</script>

<template>
  <Teleport to="body">
    <div class="overlay" @click.self="props.closeOnBackdrop === false ? undefined : emit('close')">
      <section class="dialog" :style="{ maxWidth: props.width ?? '760px' }" role="dialog" aria-modal="true" :aria-label="props.title">
        <header>
          <div><span v-if="props.kicker">{{ props.kicker }}</span><h2>{{ props.title }}</h2></div>
          <button type="button" class="close" aria-label="关闭" @click="emit('close')">关闭</button>
        </header>
        <div class="body"><slot /></div>
        <footer v-if="$slots.footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay{position:fixed;inset:0;z-index:300;display:grid;place-items:center;padding:24px;background:rgb(10 14 11 / 46%);backdrop-filter:blur(3px);overflow:auto}
.dialog{width:100%;max-height:calc(100vh - 48px);display:grid;grid-template-rows:auto minmax(0,1fr) auto;border-radius:var(--radius-lg);background:var(--surface-1);box-shadow:0 32px 80px rgb(0 0 0/.28);animation:dialog-in 220ms var(--ease-enter)}
@keyframes dialog-in{from{opacity:0;transform:translateY(10px) scale(.985)}}
.dialog>header{display:flex;justify-content:space-between;align-items:start;gap:16px;padding:26px 28px 0}
.dialog>header span{color:var(--ink-muted);font-size:9px;letter-spacing:.14em}
.dialog>header h2{margin:7px 0 0;font-size:22px}
.close{min-height:var(--control-h-sm);padding:0 14px;border:0;border-radius:12px;background:var(--surface-2);color:var(--ink);cursor:pointer;font-size:12px}
.body{padding:20px 28px;overflow:auto}
.dialog>footer{display:flex;justify-content:end;gap:10px;padding:0 28px 26px}
.dialog>footer :deep(button){min-height:44px;padding:0 22px;border:0;border-radius:14px;background:var(--ink);color:var(--canvas);cursor:pointer}
.dialog>footer :deep(button.ghost){background:var(--surface-2);color:var(--ink)}
.dialog>footer :deep(button.danger){background:var(--bad);color:var(--canvas)}
.dialog>footer :deep(button:disabled){opacity:.5;cursor:not-allowed}
@media (max-width:640px){.overlay{padding:14px}.dialog>header{padding:20px 18px 0}.body{padding:16px 18px}.dialog>footer{padding:0 18px 20px}}
</style>