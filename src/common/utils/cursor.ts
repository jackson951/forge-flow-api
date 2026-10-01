import { BadRequestException } from '@nestjs/common';

/** Opaque keyset cursor over (createdAt desc, id desc). */
export interface Cursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor({ createdAt, id }: Cursor): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString('base64url');
}

export function decodeCursor(value: string): Cursor {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as [
      string,
      string,
    ];
    const date = new Date(createdAt);
    if (typeof id !== 'string' || Number.isNaN(date.getTime())) throw new Error();
    return { createdAt: date, id };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}
