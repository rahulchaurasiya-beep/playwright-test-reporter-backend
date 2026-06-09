#!/usr/bin/env node
/**
 * Migrate local artifact files (uploads/) to S3 and update Postgres file_path.
 *
 * Usage:
 *   pnpm migrate:s3:dry              # preview only
 *   pnpm migrate:s3                  # upload + update DB
 *   pnpm migrate:s3 -- --delete-local   # also remove local files after upload
 *   pnpm migrate:s3 -- --ci-build-id=26999331755
 */

import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream, existsSync, statSync, unlinkSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "..");
const envPath = join(rootDir, ".env");
if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const deleteLocal = args.includes("--delete-local");
const ciBuildIdArg = args.find((a) => a.startsWith("--ci-build-id="));
const ciBuildIdFilter = ciBuildIdArg?.split("=")[1]?.trim();

const uploadsDir = resolve(process.env.UPLOADS_DIR ?? join(rootDir, "uploads"));
const bucket = process.env.AWS_S3_BUCKET?.trim();
const region = process.env.AWS_REGION?.trim();
const prefix = process.env.AWS_S3_PREFIX?.trim() || "artifacts";
const databaseUrl = process.env.DATABASE_URL?.trim();

const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();

const S3_STORAGE_PREFIX = "s3:";

function toS3StorageRef(objectKey) {
  return `${S3_STORAGE_PREFIX}${objectKey}`;
}

function buildObjectKey(prefixValue, ciBuildId, testId, filename) {
  const normalizedPrefix = prefixValue.replace(/^\/+|\/+$/g, "");
  return normalizedPrefix
    ? `${normalizedPrefix}/${ciBuildId}/${testId}/${filename}`
    : `${ciBuildId}/${testId}/${filename}`;
}

function resolveLocalPath(row) {
  const filename = basename(row.file_path);
  const candidates = [
    row.file_path,
    resolve(row.file_path),
    join(uploadsDir, row.ci_build_id, row.test_id, filename),
  ];

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  return resolve(row.file_path);
}

function createS3Client() {
  const credentials =
    accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;

  return new S3Client({ region, credentials });
}

function requireConfig() {
  const missing = [];
  if (!databaseUrl) missing.push("DATABASE_URL");
  if (!bucket) missing.push("AWS_S3_BUCKET");
  if (!region) missing.push("AWS_REGION");
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
}

async function uploadFile(client, localPath, objectKey, contentType) {
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: objectKey,
      Body: createReadStream(localPath),
      ContentType: contentType || "application/octet-stream",
    },
  });
  await upload.done();
}

async function main() {
  requireConfig();

  const client = createS3Client();
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();

  const params = ["s3:%"];
  let query = `
    SELECT id, ci_build_id, test_id, name, file_path, content_type, size_bytes
    FROM artifacts
    WHERE file_path NOT LIKE $1
  `;

  if (ciBuildIdFilter) {
    query += ` AND ci_build_id = $2`;
    params.push(ciBuildIdFilter);
  }

  query += ` ORDER BY created_at ASC`;

  const { rows } = await db.query(query, params);

  if (rows.length === 0) {
    console.log("No local artifacts to migrate.");
    await db.end();
    return;
  }

  console.log(
    `${dryRun ? "[dry-run] " : ""}Migrating ${rows.length} artifact(s) to s3://${bucket}/`,
  );

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const localPath = resolveLocalPath(row);

    if (!existsSync(localPath)) {
      console.warn(`SKIP missing file: ${row.id} → ${row.file_path}`);
      skipped += 1;
      continue;
    }

    const filename = basename(localPath);
    const objectKey = buildObjectKey(prefix, row.ci_build_id, row.test_id, filename);
    const storageRef = toS3StorageRef(objectKey);

    try {
      if (dryRun) {
        const size = statSync(localPath).size;
        console.log(`  would upload: ${row.id}`);
        console.log(`    local:  ${localPath}`);
        console.log(`    s3:     ${storageRef} (${size} bytes)`);
        uploaded += 1;
        continue;
      }

      await uploadFile(client, localPath, objectKey, row.content_type);

      await db.query(`UPDATE artifacts SET file_path = $1 WHERE id = $2`, [
        storageRef,
        row.id,
      ]);

      if (deleteLocal) {
        unlinkSync(localPath);
      }

      console.log(`OK ${row.id} → ${storageRef}`);
      uploaded += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`FAIL ${row.id}: ${message}`);
    }
  }

  await db.end();

  console.log("");
  console.log(
    `Done. uploaded=${uploaded} skipped=${skipped} failed=${failed}${dryRun ? " (dry-run)" : ""}`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
