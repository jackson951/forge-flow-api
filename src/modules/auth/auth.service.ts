import { Injectable, NotImplementedException } from '@nestjs/common';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@Injectable()
export class AuthService {
  register(_dto: RegisterDto): Promise<unknown> {
    throw new NotImplementedException();
  }

  login(_dto: LoginDto): Promise<unknown> {
    throw new NotImplementedException();
  }

  refresh(): Promise<unknown> {
    throw new NotImplementedException();
  }

  logout(): Promise<void> {
    throw new NotImplementedException();
  }
}
