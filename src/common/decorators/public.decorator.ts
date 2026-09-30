import { SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../constants';

/** Marks a route as not requiring authentication. Everything else is protected by default. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
