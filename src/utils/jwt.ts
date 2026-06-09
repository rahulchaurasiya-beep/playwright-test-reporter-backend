import jwt, { type SignOptions } from "jsonwebtoken";

export type JwtPayload = {
  userId: string;
  username: string | null;
  email: string | null;
};

function readSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error("JWT_SECRET is required");
  }
  return secret;
}

function readExpiresIn(): string {
  return process.env.JWT_EXPIRES_IN?.trim() || "7d";
}

export function signUserToken(payload: JwtPayload): string {
  const options: SignOptions = { expiresIn: readExpiresIn() as SignOptions["expiresIn"] };
  return jwt.sign(payload, readSecret(), options);
}

export function verifyUserToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, readSecret());
  if (typeof decoded !== "object" || decoded === null || !("userId" in decoded)) {
    throw new Error("Invalid token");
  }

  const record = decoded as Record<string, unknown>;
  return {
    userId: String(record.userId),
    username: typeof record.username === "string" ? record.username : null,
    email: typeof record.email === "string" ? record.email : null,
  };
}
