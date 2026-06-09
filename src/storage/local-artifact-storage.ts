import type { Response } from "express";
import { createReadStream, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ArtifactStorage, ArtifactStorageConfig } from "./artifact-storage.js";

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function createLocalArtifactStorage(
  config: Pick<ArtifactStorageConfig, "uploadsDir" | "mode">,
): ArtifactStorage {
  const { uploadsDir } = config;

  return {
    mode: "local",

    buildFilename(originalName: string): string {
      return `${Date.now()}-${safeFilename(originalName)}`;
    },

    async persistUploadedFile(params) {
      const destinationDir = join(uploadsDir, params.ciBuildId, params.testId);
      const destinationPath = join(destinationDir, params.filename);

      mkdirSync(destinationDir, { recursive: true });
      renameSync(params.tempPath, destinationPath);

      return {
        storageRef: resolve(destinationPath),
        sizeBytes: params.sizeBytes,
      };
    },

    async serveArtifact(res, ref) {
      if (!existsSync(ref.filePath)) {
        return false;
      }

      res.setHeader("Content-Type", ref.contentType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${safeFilename(ref.name)}"`,
      );

      await pipeline(createReadStream(ref.filePath), res);
      return true;
    },
  };
}
