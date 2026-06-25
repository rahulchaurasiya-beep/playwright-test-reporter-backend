import bcrypt from "bcryptjs";
import type { DbClient } from "../postgres-db-client.js";
import type { PublicUser, SignupPayload, UserRecord } from "../../types/user.js";
import { generateUserId, isValidEmail, normalizeEmail, normalizeUsername } from "../../utils/users.js";

type UserRow = {
  user_id: string;
  username: string | null;
  email: string | null;
  password_hash: string;
  created_at: string;
  updated_at: string;
};

function mapUser(row: UserRow): UserRecord {
  return {
    userId: row.user_id,
    username: row.username,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicUser(user: UserRecord): PublicUser {
  return {
    userId: user.userId,
    username: user.username,
    email: user.email,
  };
}

const PASSWORD_MIN_LENGTH = 8;
const BCRYPT_ROUNDS = 10;

export class UserStore {
  constructor(private readonly db: DbClient) {}

  async createUser(payload: SignupPayload): Promise<UserRecord> {
    const username = payload.username?.trim()
      ? normalizeUsername(payload.username)
      : null;
    const email = payload.email?.trim() ? normalizeEmail(payload.email) : null;
    const password = payload.password ?? "";

    if (!username && !email) {
      throw new Error("Username or email is required");
    }
    if (username && username.length < 3) {
      throw new Error("Username must be at least 3 characters");
    }
    if (email && !isValidEmail(email)) {
      throw new Error("Invalid email address");
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    }

    if (username) {
      const existingUsername = await this.findByUsername(username);
      if (existingUsername) {
        throw new Error("Username is already taken");
      }
    }

    if (email) {
      const existingEmail = await this.findByEmail(email);
      if (existingEmail) {
        throw new Error("Email is already registered");
      }
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const now = new Date().toISOString();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const userId = generateUserId();
      try {
        await this.db.execute(
          `INSERT INTO users (user_id, username, email, password_hash, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $5)`,
          [userId, username, email, passwordHash, now],
        );

        const user = await this.getUserById(userId);
        if (!user) {
          throw new Error("Failed to load created user");
        }
        return user;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("duplicate") || message.includes("UNIQUE")) {
          if (message.includes("username")) {
            throw new Error("Username is already taken");
          }
          if (message.includes("email")) {
            throw new Error("Email is already registered");
          }
          continue;
        }
        throw error;
      }
    }

    throw new Error("Could not create user");
  }

  async authenticate(payload: {
    username?: string;
    email?: string;
    password: string;
  }): Promise<UserRecord | null> {
    console.log("authenticate payload", payload);
    const username = payload.username?.trim()
      ? normalizeUsername(payload.username)
      : null;
    const email = payload.email?.trim() ? normalizeEmail(payload.email) : null;
    const password = payload.password ?? "";

    if (!password) {
      throw new Error("Password is required");
    }
    if (!username && !email) {
      throw new Error("Username or email is required");
    }

    const user =
      (username ? await this.findByUsername(username) : null) ??
      (email ? await this.findByEmail(email) : null);

    if (!user) {
      return null;
    }

    const row = await this.db.queryOne<UserRow>(
      "SELECT * FROM users WHERE user_id = $1",
      [user.userId],
    );
    if (!row) {
      return null;
    }

    const valid = await bcrypt.compare(password, row.password_hash);
    return valid ? mapUser(row) : null;
  }

  async getUserById(userId: string): Promise<UserRecord | null> {
    const row = await this.db.queryOne<UserRow>(
      "SELECT user_id, username, email, created_at, updated_at FROM users WHERE user_id = $1",
      [userId],
    );
    return row ? mapUser({ ...row, password_hash: "" }) : null;
  }

  async findByUsername(username: string): Promise<UserRecord | null> {
    const row = await this.db.queryOne<UserRow>(
      "SELECT user_id, username, email, created_at, updated_at FROM users WHERE username = $1",
      [normalizeUsername(username)],
    );
    return row ? mapUser({ ...row, password_hash: "" }) : null;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.db.queryOne<UserRow>(
      "SELECT user_id, username, email, created_at, updated_at FROM users WHERE email = $1",
      [normalizeEmail(email)],
    );
    return row ? mapUser({ ...row, password_hash: "" }) : null;
  }

  toPublicUser(user: UserRecord): PublicUser {
    return toPublicUser(user);
  }
}
