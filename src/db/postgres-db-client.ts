import pg from "pg";
import { SCHEMA_SQL } from "./schema.js";

const { Pool } = pg;

export type DbClient = {
  migrate(): Promise<void>;
  close(): Promise<void>;
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | undefined>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
};

export class PostgresDbClient implements DbClient {
  private readonly pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 20,
    });
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
    await this.pool.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS api_key TEXT");
    await this.pool.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_user_id TEXT");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  async queryOne<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    const result = await this.pool.query(sql, params);
    return (result.rows[0] as T | undefined) ?? undefined;
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
    const result = await this.pool.query(sql, params);
    return { rowCount: result.rowCount ?? 0 };
  }
}
