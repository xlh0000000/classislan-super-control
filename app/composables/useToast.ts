export type ToastKind = "ok" | "err" | "info";
export type Toast = { id: number; kind: ToastKind; text: string };

let sequence = 0;

/**
 * 全局提示：所有成功/失败反馈都走这里，页面里不再插入提示元素。
 */
export function useToast() {
  const toasts = useState<Toast[]>("cic-toasts", () => []);

  function dismiss(id: number) {
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }

  function push(kind: ToastKind, text: string, ttl = 4200) {
    if (!text) return;
    sequence += 1;
    const id = sequence;
    toasts.value = [...toasts.value, { id, kind, text }];
    if (import.meta.client) window.setTimeout(() => dismiss(id), ttl);
    return id;
  }

  return {
    toasts,
    push,
    dismiss,
    ok: (text: string) => push("ok", text),
    err: (text: string) => push("err", text),
    info: (text: string) => push("info", text),
  };
}