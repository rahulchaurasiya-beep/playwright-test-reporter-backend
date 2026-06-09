import type { Response } from "express";
import { createLocalArtifactStorage } from "./local-artifact-storage.js";
import { createS3ArtifactStorage } from "./s3-artifact-storage.js";

export type ArtifactStorageMode = "local" | "s3";
export type S3ArtifactUrlMode = "proxy" | "redirect";

export type ArtifactFileRef = {
  filePath: string;
  contentType: string;
  name: string;
};

export interface ArtifactStorage {
  readonly mode: ArtifactStorageMode;
  buildFilename(originalName: string): string;
  persistUploadedFile(params: {
    ciBuildId: string;
    testId: string;
    filename: string;
    tempPath: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<{ storageRef: string; sizeBytes: number }>;
  serveArtifact(res: Response, ref: ArtifactFileRef): Promise<boolean>;
}

export type ArtifactStorageConfig = {
  uploadsDir: string;
  mode: ArtifactStorageMode;
  s3?: {
    region: string;
    bucket: string;
    prefix: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    urlMode: S3ArtifactUrlMode;
    presignExpiresSec: number;
  };
};

function resolveMode(value: string | undefined): ArtifactStorageMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "s3") return "s3";
  return "local";
}

export function createArtifactStorageFromEnv(uploadsDir: string): ArtifactStorage {
  const mode = resolveMode(process.env.ARTIFACT_STORAGE);

  if (mode === "s3") {
    const bucket = process.env.AWS_S3_BUCKET?.trim();
    const region = process.env.AWS_REGION?.trim();

    if (!bucket || !region) {
      throw new Error(
        "ARTIFACT_STORAGE=s3 requires AWS_S3_BUCKET and AWS_REGION to be set",
      );
    }

    const urlMode =
      process.env.S3_ARTIFACT_URL_MODE?.trim().toLowerCase() === "redirect"
        ? "redirect"
        : "proxy";

    const presignExpiresSec = Number.parseInt(
      process.env.S3_PRESIGN_EXPIRES_SEC ?? "3600",
      10,
    );

    return createS3ArtifactStorage({
      uploadsDir,
      mode: "s3",
      s3: {
        region,
        bucket,
        prefix: process.env.AWS_S3_PREFIX?.trim() || "artifacts",
        accessKeyId: process.env.AWS_ACCESS_KEY_ID?.trim(),
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY?.trim(),
        urlMode,
        presignExpiresSec: Number.isFinite(presignExpiresSec) ? presignExpiresSec : 3600,
      },
    });
  }

  return createLocalArtifactStorage({ uploadsDir, mode: "local" });
}
