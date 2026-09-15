export default defineEventHandler((event) => {
  const user = getSessionUser(event);
  return { authenticated: Boolean(user), user };
});
