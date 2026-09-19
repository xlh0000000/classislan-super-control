export default defineEventHandler((event) => {
  const user = getSessionUser(event);
  // sessionId 只服务于服务端内部（改密时保留当前会话），不随会话信息下发。
  if (!user) return { authenticated: false, user: null };
  const { sessionId: _sessionId, ...profile } = user;
  return { authenticated: true, user: profile };
});
