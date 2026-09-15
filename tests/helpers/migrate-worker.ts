import Database from "better-sqlite3";
import { migrate } from "../../server/migrations/index.ts";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("missing database path");
  process.exit(2);
}
const db = new Database(dbPath);
db.pragma("busy_timeout = 10000");
db.pragma("journal_mode = WAL");
try {
  migrate(db);
} catch (error) {
  console.error((error as Error).message);
  process.exit(3);
} finally {
  db.close();
}