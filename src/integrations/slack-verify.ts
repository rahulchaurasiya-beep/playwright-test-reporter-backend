import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_VERSION = "v0";
/** Reject requests whose timestamp is older than this (replay protection). */
const MAX_SKEW_SECONDS = 60 * 5;

export type SlackVerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify a Slack request signature.
 * See https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(args: {
  signingSecret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer | string;
}): SlackVerifyResult {
  const { signingSecret, signature, timestamp, rawBody } = args;

  if (!signature || !timestamp) {
    return { ok: false, reason: "Missing Slack signature headers" };
  }

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "Invalid Slack timestamp" };
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: "Slack timestamp outside allowed window" };
  }

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const base = `${SIGNATURE_VERSION}:${timestamp}:${body}`;
  const expected = `${SIGNATURE_VERSION}=${createHmac("sha256", signingSecret)
    .update(base)
    .digest("hex")}`;

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) {
    return { ok: false, reason: "Signature mismatch" };
  }
  if (!timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: "Signature mismatch" };
  }

  return { ok: true };
}
