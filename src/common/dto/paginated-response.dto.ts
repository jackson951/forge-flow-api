export class PaginatedResponseDto<T> {
  items: T[];
  nextCursor: string | null;
}
