import { randomBytes } from "node:crypto";

const USER_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

export function generateUserId(length = 12): string {
  const bytes = randomBytes(length);
  let id = "usr_";
  for (let i = 0; i < length; i += 1) {
    id += USER_ID_ALPHABET[bytes[i]! % USER_ID_ALPHABET.length];
  }
  return id;
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
