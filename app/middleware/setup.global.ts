export default defineNuxtRouteMiddleware(async (to) => {
  const headers = import.meta.server ? useRequestHeaders(["cookie"]) : undefined;
  const fetchJson = async <T>(path: string) => await $fetch<T>(path, { headers });
  if (to.path === "/setup") return;
  const { initialized } = await fetchJson<{ initialized: boolean }>("/api/v1/setup/status");
  if (!initialized) return navigateTo("/setup");
  if (to.path === "/login") return;
  const session = await fetchJson<{ authenticated: boolean }>("/api/v1/auth/session");
  if (!session.authenticated) return navigateTo("/login");
});
