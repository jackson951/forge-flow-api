import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';

export const TEST_PASSWORD = 'correct horse battery staple';

export interface RegisteredUser {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

/** Registers through the real API and returns the session. */
export async function registerUser(server: App, email = uniqueEmail()): Promise<RegisteredUser> {
  const res = await request(server)
    .post('/api/v1/auth/register')
    .send({ email, password: TEST_PASSWORD, name: 'Test User' })
    .expect(201);
  return {
    id: res.body.user.id,
    email,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
