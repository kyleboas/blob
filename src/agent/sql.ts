type SqlExecutor = {
  exec: (query: string, ...args: unknown[]) => Iterable<Record<string, unknown>>;
};

type ReadSqlOptions = {
  onRecovered?: (error: unknown) => void;
};

export function isMissingSqlResultError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Expected exactly one result from SQL query, but got no results.");
}

export function readSqlRows(
  sql: SqlExecutor,
  query: string,
  args: unknown[] = [],
  options?: ReadSqlOptions,
): Array<Record<string, unknown>> {
  try {
    return [...sql.exec(query, ...args)] as Array<Record<string, unknown>>;
  } catch (error) {
    if (isMissingSqlResultError(error)) {
      options?.onRecovered?.(error);
      return [];
    }
    throw error;
  }
}
