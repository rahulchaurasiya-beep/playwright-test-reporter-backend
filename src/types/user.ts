export type UserRecord = {
  userId: string;
  username: string | null;
  email: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicUser = {
  userId: string;
  username: string | null;
  email: string | null;
};

export type SignupPayload = {
  username?: string;
  email?: string;
  password: string;
};

export type LoginPayload = {
  username?: string;
  email?: string;
  password: string;
};

export type AuthResponse = {
  token: string;
  user: PublicUser;
};
