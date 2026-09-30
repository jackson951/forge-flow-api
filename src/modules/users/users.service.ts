import { Injectable, NotImplementedException } from '@nestjs/common';

@Injectable()
export class UsersService {
  findById(_id: string): Promise<unknown> {
    throw new NotImplementedException();
  }

  findByEmail(_email: string): Promise<unknown> {
    throw new NotImplementedException();
  }
}
