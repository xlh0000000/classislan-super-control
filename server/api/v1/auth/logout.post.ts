export default defineEventHandler((event) => {
  const user = getSessionUser(event);
  if (user) {
    withAuditedTransaction(
      () => { destroySession(event); return user.id; },
      () => ({ actorType: "user", actorId: user.id, action: "auth.logout", targetType: "session", summary: `${user.username} 退出控制平面` }),
    );
  } else {
    destroySession(event);
  }
  return { authenticated: false };
});