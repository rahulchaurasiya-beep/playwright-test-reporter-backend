export const S3_STORAGE_PREFIX = "s3:";

export function isS3StorageRef(storageRef: string): boolean {
  return storageRef.startsWith(S3_STORAGE_PREFIX);
}

export function toS3StorageRef(objectKey: string): string {
  return `${S3_STORAGE_PREFIX}${objectKey}`;
}

export function fromS3StorageRef(storageRef: string): string {
  return storageRef.startsWith(S3_STORAGE_PREFIX)
    ? storageRef.slice(S3_STORAGE_PREFIX.length)
    : storageRef;
}

export function buildObjectKey(
  prefix: string,
  ciBuildId: string,
  testId: string,
  filename: string,
): string {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  return normalizedPrefix
    ? `${normalizedPrefix}/${ciBuildId}/${testId}/${filename}`
    : `${ciBuildId}/${testId}/${filename}`;
}
