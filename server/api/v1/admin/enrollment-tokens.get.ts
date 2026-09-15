type TokenRow = {
  id: string; kind: string; orgNodeId: string | null; maxUses: number;
  useCount: number; expiresAt: string; createdAt: string; revokedAt: string | null;
};

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "enrollment.write");
  assertSchoolWideScope(user, "设备接入凭据");
  const db = useDatabase();
  const tokens = db.prepare(`SELECT id,kind,org_node_id orgNodeId,max_uses maxUses,use_count useCount,expires_at expiresAt,created_at createdAt,revoked_at revokedAt
    FROM enrollment_tokens ORDER BY created_at DESC LIMIT 200`).all() as TokenRow[];
  const tagRows = db.prepare("SELECT enrollment_token_id tokenId,tag_id tagId FROM enrollment_token_tags").all() as { tokenId: string; tagId: string }[];
  const tagsByToken = new Map<string, string[]>();
  for (const row of tagRows) {
    const list = tagsByToken.get(row.tokenId);
    if (list) list.push(row.tagId);
    else tagsByToken.set(row.tokenId, [row.tagId]);
  }
  return tokens.map((token) => ({ ...token, tagIds: tagsByToken.get(token.id) ?? [] }));
});