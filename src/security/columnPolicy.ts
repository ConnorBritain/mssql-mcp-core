export type ColumnPolicyMap = Record<string, string[]>;

export interface ColumnPolicy {
  allowedColumns?: ColumnPolicyMap;
  deniedColumns?: ColumnPolicyMap;
}

export interface ColumnPolicyDecision {
  allowed: boolean;
  reason?: string;
}

function matchesPattern(value: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${regexPattern}$`, "i").test(value);
}

export function matchesAccessPattern(value: string, pattern: string): boolean {
  return matchesPattern(value, pattern);
}

export function isSchemaTableAllowed(
  policy: { allowedSchemas?: string[]; deniedSchemas?: string[] } | undefined,
  schemaName: string,
  tableName: string,
): boolean {
  const ref = `${schemaName}.${tableName}`;
  if ((policy?.deniedSchemas ?? []).some((pattern) => matchesPattern(ref, pattern) || matchesPattern(schemaName, pattern))) return false;
  return !(policy?.allowedSchemas?.length) || policy.allowedSchemas.some((pattern) => matchesPattern(ref, pattern) || matchesPattern(schemaName, pattern));
}

export function hasColumnPolicy(policy: ColumnPolicy | undefined, tableRef: string): boolean {
  return Object.keys(policy?.allowedColumns ?? {}).some((pattern) => matchesPattern(tableRef, pattern)) ||
    Object.keys(policy?.deniedColumns ?? {}).some((pattern) => matchesPattern(tableRef, pattern));
}

function matchingColumns(map: ColumnPolicyMap | undefined, tableRef: string): Set<string> {
  const result = new Set<string>();
  for (const [pattern, columns] of Object.entries(map ?? {})) {
    if (matchesPattern(tableRef, pattern)) {
      for (const column of columns) result.add(column.toLowerCase());
    }
  }
  return result;
}

export function checkColumnPolicy(
  policy: ColumnPolicy | undefined,
  tableRef: string,
  columnName: string,
): ColumnPolicyDecision {
  const allowed = matchingColumns(policy?.allowedColumns, tableRef);
  const denied = matchingColumns(policy?.deniedColumns, tableRef);
  const normalizedColumn = columnName.toLowerCase();

  if (denied.has(normalizedColumn)) {
    return {
      allowed: false,
      reason: `Column '${columnName}' is denied by the column policy for '${tableRef}'.`,
    };
  }

  if (allowed.size > 0 && !allowed.has(normalizedColumn)) {
    return {
      allowed: false,
      reason: `Column '${columnName}' is not in the allowed column policy for '${tableRef}'.`,
    };
  }

  return { allowed: true };
}

export function filterRecordColumns(
  policy: ColumnPolicy | undefined,
  tableRef: string,
  records: Record<string, unknown>[],
): Record<string, unknown>[] {
  return records.map((record) => Object.fromEntries(
    Object.entries(record).filter(([columnName]) => checkColumnPolicy(policy, tableRef, columnName).allowed),
  ));
}

export function filterAllowedColumns<T extends { columnName?: string; name?: string }>(
  policy: ColumnPolicy | undefined,
  tableRef: string,
  columns: T[],
): T[] {
  return columns.filter((column) => {
    const name = column.columnName ?? column.name;
    return typeof name === "string" && checkColumnPolicy(policy, tableRef, name).allowed;
  });
}

export function tableReference(tableName: string): string {
  const parts = tableName.split(".").map((part) => part.replace(/^\[|\]$/g, ""));
  return parts.length >= 2 ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}` : `dbo.${parts[0]}`;
}

export function validateColumnNames(
  policy: ColumnPolicy | undefined,
  tableRef: string,
  columnNames: string[],
): ColumnPolicyDecision {
  for (const columnName of columnNames) {
    const decision = checkColumnPolicy(policy, tableRef, columnName);
    if (!decision.allowed) return decision;
  }
  return { allowed: true };
}
