import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Response } from "express";
import { createReadStream, unlinkSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { ArtifactStorage, ArtifactStorageConfig } from "./artifact-storage.js";
import {
  buildObjectKey,
  fromS3StorageRef,
  isS3StorageRef,
  toS3StorageRef,
} from "./storage-key.js";

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function createS3Client(config: NonNullable<ArtifactStorageConfig["s3"]>): S3Client {
  const credentials =
    config.accessKeyId && config.secretAccessKey
      ? {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        }
      : undefined;

  return new S3Client({
    region: config.region,
    credentials,
  });
}

export function createS3ArtifactStorage(config: ArtifactStorageConfig): ArtifactStorage {
  if (!config.s3) {
    throw new Error("S3 artifact storage requires s3 config");
  }

  const s3Config = config.s3;
  const client = createS3Client(s3Config);

  return {
    mode: "s3",

    buildFilename(originalName: string): string {
      return `${Date.now()}-${safeFilename(originalName)}`;
    },

    async persistUploadedFile(params) {
      const objectKey = buildObjectKey(
        s3Config.prefix,
        params.ciBuildId,
        params.testId,
        params.filename,
      );

      try {
        const upload = new Upload({
          client,
          params: {
            Bucket: s3Config.bucket,
            Key: objectKey,
            Body: createReadStream(params.tempPath),
            ContentType: params.contentType,
          },
        });

        await upload.done();

        return {
          storageRef: toS3StorageRef(objectKey),
          sizeBytes: params.sizeBytes,
        };
      } finally {
        try {
          unlinkSync(params.tempPath);
        } catch {
          // temp file may already be removed
        }
      }
    },

    async serveArtifact(res, ref) {
      if (!isS3StorageRef(ref.filePath)) {
        return false;
      }

      const objectKey = fromS3StorageRef(ref.filePath);
      const command = new GetObjectCommand({
        Bucket: s3Config.bucket,
        Key: objectKey,
      });

      if (s3Config.urlMode === "redirect") {
        const url = await getSignedUrl(client, command, {
          expiresIn: s3Config.presignExpiresSec,
        });
        res.redirect(302, url);
        return true;
      }

      const result = await client.send(command);
      if (!result.Body) {
        return false;
      }

      res.setHeader("Content-Type", ref.contentType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${safeFilename(ref.name)}"`,
      );

      if (result.ContentLength !== undefined) {
        res.setHeader("Content-Length", String(result.ContentLength));
      }

      await pipeline(result.Body as NodeJS.ReadableStream, res);
      return true;
    },
  };
}
