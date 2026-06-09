import { PostgresDbClient, type DbClient } from "../postgres-db-client.js";
import { SqlRunStore } from "./run-store.js";
import type { IRunStore } from "./run-store.interface.js";

export type StoreBundle = {
  store: IRunStore;
  db: DbClient;
};

export async function createRunStore(options: {
  databaseUrl?: string;
} = {}): Promise<StoreBundle> {
  const url =
    options.databaseUrl ??
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/rocketium_e2e_runs";
  const db = new PostgresDbClient(url);
  await db.migrate();
  console.log("  Storage: PostgreSQL");
  return { store: new SqlRunStore(db), db };
}
