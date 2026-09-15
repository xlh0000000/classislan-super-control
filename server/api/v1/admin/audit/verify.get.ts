import { latestAuditCheckpoint, verifyAuditCheckpointSignature } from "../../../../utils/audit-checkpoint";
import { getServerSigningIdentity } from "../../../../utils/server-signing";
import { verifyAuditChain } from "../../../../utils/security";

export default defineEventHandler((event) => {
  requirePermission(event.context.user as { role: string }, "audit.read");
  const db = useDatabase();
  try {
    const chain = verifyAuditChain(db);
    const checkpoint = latestAuditCheckpoint(db);
    // 链头早于最新检查点，说明检查点之后的事件被整体删除：这是比断链更强的篡改信号。
    const checkpointMatchesHead = checkpoint ? checkpoint.sequence <= chain.lastSequence : true;
    let checkpointVerified: boolean | null = null;
    if (checkpoint) {
      try { checkpointVerified = verifyAuditCheckpointSignature(checkpoint, getServerSigningIdentity().publicKeyDer); }
      catch { checkpointVerified = false; }
    }
    return { ...chain, latestCheckpoint: checkpoint, checkpointMatchesHead, checkpointVerified };
  } catch (error) {
    throw createError({ statusCode: 409, statusMessage: "audit-chain-invalid", message: (error as Error).message });
  }
});