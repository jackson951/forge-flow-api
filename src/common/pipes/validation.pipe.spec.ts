import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsEmail, IsInt, Min, ValidateNested } from 'class-validator';
import { createValidationPipe } from './validation.pipe';

class Inner {
  @IsInt()
  @Min(1)
  count: number;
}

class Probe {
  @IsEmail()
  email: string;

  @ValidateNested()
  @Type(() => Inner)
  inner: Inner;
}

describe('createValidationPipe', () => {
  const pipe = createValidationPipe();
  const meta = { type: 'body' as const, metatype: Probe };

  it('returns field-level details including nested paths', async () => {
    const error = await pipe
      .transform({ email: 'nope', inner: { count: 0 } }, meta)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      message: 'Validation failed',
      details: [
        { field: 'email', messages: ['email must be an email'] },
        { field: 'inner.count', messages: ['count must not be less than 1'] },
      ],
    });
  });

  it('rejects properties that are not declared on the DTO', async () => {
    const error = await pipe
      .transform({ email: 'a@b.co', inner: { count: 1 }, isAdmin: true }, meta)
      .catch((e: BadRequestException) => e.getResponse());

    expect(error).toMatchObject({
      details: [{ field: 'isAdmin', messages: ['property isAdmin should not exist'] }],
    });
  });

  it('passes valid input through', async () => {
    await expect(
      pipe.transform({ email: 'a@b.co', inner: { count: 2 } }, meta),
    ).resolves.toBeInstanceOf(Probe);
  });
});
