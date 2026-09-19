import { roleCan } from "#shared/permissions";

export type SessionProfile = {
  id: string;
  username: string;
  displayName: string;
  role: string;
  scopeOrgNodeId: string | null;
  /** 管理员代设的初始密码还没换掉：此时除改密以外都进不了管理端。 */
  mustChangePassword: boolean;
};

export type SessionPayload = { authenticated: boolean; user: SessionProfile | null };

/** 全站登录身份：由 setup.global 中间件在每次导航时写入，界面据此收起做不到的入口。 */
export function useSession() {
  const state = useState<SessionPayload | null>("session", () => null);
  const user = computed(() => state.value?.user ?? null);
  const can = (permission: string) => roleCan(user.value?.role, permission);
  /** 改密这类会改变账号自身状态的调用之后刷新，强制首改的遮罩才会松开。 */
  async function refresh() {
    state.value = await $fetch<SessionPayload>("/api/v1/auth/session");
    return state.value;
  }
  return { user, can, refresh, mustChangePassword: computed(() => user.value?.mustChangePassword === true) };
}
