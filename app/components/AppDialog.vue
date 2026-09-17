<script setup lang="ts">
// 贡献者：威廉
/**
 * closeOnBackdrop 必须给默认值：声明成 Boolean 的 prop 在“没传”时会被 Vue 强制解析为
 * false，于是 `closeOnBackdrop === false` 恒成立，× 与 Esc 会一起失效。
 */
const props = withDefaults(
  defineProps<{ title: string; kicker?: string; width?: string; closeOnBackdrop?: boolean }>(),
  { kicker: "", closeOnBackdrop: true },
);
const emit = defineEmits<{ close: [] }>();

const closing = ref(false);

/** 显式关闭：× 与 Esc 始终有效。退出动画 200ms 播完后再卸载，进场为 300ms + 12px 上浮。 */
function close() {
  if (closing.value) return;
  closing.value = true;
  window.setTimeout(() => emit("close"), 200);
}

/** 点遮罩关闭是可选项，只有显式传 close-on-backdrop=false 才禁用。 */
function onBackdropClick() {
  if (props.closeOnBackdrop === false) return;
  close();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") close();
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
    <div class="overlay" :class="{ closing }" @click.self="onBackdropClick">
      <section class="dialog" :class="{ closing }" :style="{ maxWidth: props.width ?? '760px' }" role="dialog" aria-modal="true" :aria-label="props.title">
        <header class="dialog-top">
          <span>{{ props.kicker }}</span>
          <button type="button" class="close" aria-label="关闭" @click="close">
            关闭<span class="x" aria-hidden="true" />
          </button>
        </header>
        <div class="dialog-body">
          <h2>{{ props.title }}</h2>
          <div class="body fade-in"><slot /></div>
        </div>
        <footer v-if="$slots.footer" class="dialog-foot"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* 浮层：RhineLab .modal-backdrop / .terminal-modal —— 暖白磨砂 + 唯一允许的投影。 */
.overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(227 224 215 / 45%);
  backdrop-filter: blur(18px);
  overflow: auto;
  animation: overlay-in var(--t-enter) var(--ease-enter);
}
:root[data-theme="dark"] .overlay { background: rgb(12 13 9 / 55%); }
.dialog {
  width: 100%;
  max-height: calc(100vh - 48px);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  border: 1px solid #f7f5ee;
  background: rgb(237 235 228 / 97%);
  box-shadow: var(--shadow-pop);
  animation: dialog-in var(--t-enter) var(--ease-enter);
}
:root[data-theme="dark"] .dialog { border-color: var(--surface-3); background: rgb(28 30 23 / 97%); }
@keyframes overlay-in { from { opacity: 0; } }
@keyframes dialog-in { from { opacity: 0; transform: translateY(12px); } }
.overlay.closing { animation: overlay-out var(--t-mid) var(--ease-exit) forwards; }
.dialog.closing { animation: dialog-out var(--t-mid) var(--ease-exit) forwards; }
@keyframes overlay-out { to { opacity: 0; } }
@keyframes dialog-out { to { opacity: 0; transform: translateY(8px); } }

.dialog-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 20px 30px;
  border-bottom: 1px solid var(--line-strong);
  color: var(--ink-muted);
  font-size: 11px;
  letter-spacing: 1px;
}
.close {
  display: inline-flex;
  align-items: center;
  gap: 14px;
  min-height: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink-soft);
  font-size: 11px;
  letter-spacing: 1px;
}
.close:hover { border: 0; background: none; color: var(--accent); }
/* RhineLab 的关闭符号是两根 2px 实心线，不依赖字体字形。 */
.x { position: relative; width: 16px; height: 16px; flex: none; font-size: 0; }
.x::before, .x::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 14px;
  height: 2px;
  background: currentColor;
  transform: translate(-50%, -50%) rotate(45deg);
}
.x::after { transform: translate(-50%, -50%) rotate(-45deg); }

.dialog-body { overflow: auto; }
.dialog-body h2 { margin: 30px 30px 0; font-size: clamp(26px, 2.6vw, 36px); font-weight: 600; letter-spacing: -0.8px; }
.body { padding: 20px 30px 28px; }
.dialog-foot { display: flex; justify-content: end; gap: 10px; padding: 0 30px 26px; }
.dialog-foot :deep(button) {
  min-height: var(--control-h);
  padding: 0 18px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink-soft);
  font-size: 11px;
  letter-spacing: 1px;
}
.dialog-foot :deep(button:hover:not(:disabled)) { border-color: var(--accent); background: var(--accent-wash); color: var(--ink); }
.dialog-foot :deep(button:not(.ghost):not(.danger)) { border: 0; background: var(--fill); color: var(--fill-ink); }
.dialog-foot :deep(button:not(.ghost):not(.danger):hover:not(:disabled)) { border: 0; background: var(--fill-hover); color: var(--fill-ink); }
.dialog-foot :deep(button.danger) { border-color: var(--bad); color: var(--bad); }
.dialog-foot :deep(button.danger:hover:not(:disabled)) { background: color-mix(in srgb, var(--bad) 12%, transparent); border-color: var(--bad); color: var(--bad); }
.dialog-foot :deep(button:disabled) { opacity: 0.45; cursor: not-allowed; }

@media (max-width: 640px) {
  .overlay { padding: 0; }
  .dialog { max-height: 100vh; min-height: 100vh; border: 0; }
  .dialog-top { padding: 16px 18px; }
  .dialog-body h2 { margin: 22px 18px 0; }
  .body { padding: 16px 18px 22px; }
  .dialog-foot { padding: 0 18px 20px; flex-wrap: wrap; }
}
</style>