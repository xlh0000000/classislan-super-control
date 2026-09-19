import type { SessionPayload } from "../composables/useSession";

export default defineNuxtRouteMiddleware(async (to) => {
  const headers = import.meta.server ? useRequestHeaders(["cookie"]) : undefined;
  const fetchJson = async <T>(path: string) => await $fetch<T>(path, { headers });
  if (to.path === "/setup") return;
  const { initialized } = await fetchJson<{ initialized: boolean }>("/api/v1/setup/status");
  if (!initialized) return navigateTo("/setup");
  if (to.path === "/login") return;
  const session = await fetchJson<SessionPayload>("/api/v1/auth/session");
  // 身份存进全站状态，导航与页面直接读，不必再各自发一次会话请求。
  useState<SessionPayload>("session").value = session;
  if (!session.authenticated) return navigateTo("/login");
  // 初始密码没换掉前管理端接口一律拒绝：把人留在楼栋页，改密弹窗会盖在上面。
  if (session.user?.mustChangePassword && to.path !== "/") return navigateTo("/");
});
