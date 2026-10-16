import Sqlite from 'better-sqlite3';

export function sqliteCode(err: unknown): string | undefined {
  return err instanceof Sqlite.SqliteError ? err.code : undefined;
}

type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

// Object.fromEntries loses key types; the filter is what makes the cast true.
export function definedOnly<T extends object>(patch: T): Defined<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Defined<T>;
}

export const toFlag = (b: boolean): number => (b ? 1 : 0);
