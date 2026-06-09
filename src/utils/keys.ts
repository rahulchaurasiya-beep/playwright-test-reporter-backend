import { createHash, randomBytes } from "node:crypto";

const PROJECT_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

export function generateProjectId(length = 6): string {
  const bytes = randomBytes(length);
  let id = "";
  for (let i = 0; i < length; i += 1) {
    id += PROJECT_ID_ALPHABET[bytes[i]! % PROJECT_ID_ALPHABET.length];
  }
  return id;
}

export function generateApiKey(): string {
  return `rptr_live_${randomBytes(24).toString("hex")}`;
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function apiKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, 16);
}

export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 12) return "****";
  return `${apiKey.slice(0, 12)}${"•".repeat(8)}${apiKey.slice(-4)}`;
}
