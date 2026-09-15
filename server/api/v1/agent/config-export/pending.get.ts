export default defineEventHandler((event) => {
  requirePermission(event.context.user as { role: string }, "configurations.read");
  const db = useDatabase();
  const rows = db.prepare(`SELECT cr.id,cr.configuration_id configurationId,c.name,cr.expires_at expiresAt,cr.created_at createdAt
    FROM config_requests cr JOIN configurations c ON c.id=cr.configuration_id
    WHERE cr.state='requested' AND cr.expires_at>? ORDER BY cr.created_at`).all(nowIso()) as Record<string, unknown>[];
  return rows;
});