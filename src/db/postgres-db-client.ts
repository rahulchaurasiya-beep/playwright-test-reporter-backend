import pg from "pg";
import { SCHEMA_SQL } from "./schema.js";

const { Pool } = pg;

/** Remove ssl* query params so Pool ssl config is not overridden by pg-connection-string. */
function stripSslQueryParams(connectionString: string): string {
  const q = connectionString.indexOf("?");
  if (q === -1) return connectionString;
  const base = connectionString.slice(0, q);
  const params = new URLSearchParams(connectionString.slice(q + 1));
  for (const key of ["sslmode", "ssl", "uselibpqcompat"]) {
    params.delete(key);
  }
  const rest = params.toString();
  return rest ? `${base}?${rest}` : base;
}

/** RDS requires encrypted connections; skip CA verify (Amazon RDS CA). */
function resolveSsl(
  connectionString: string,
): { rejectUnauthorized: boolean } | undefined {
  const flag = process.env.DATABASE_SSL?.trim().toLowerCase();
  if (flag === "false" || flag === "0") return undefined;
  if (flag === "true" || flag === "1") return { rejectUnauthorized: false };
  if (connectionString.includes("rds.amazonaws.com")) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

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
    const ssl = resolveSsl(connectionString);
    const normalizedUrl = ssl ? stripSslQueryParams(connectionString) : connectionString;
    this.pool = new Pool({
      connectionString: normalizedUrl,
      max: 20,
      ...(ssl ? { ssl } : {}),
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
