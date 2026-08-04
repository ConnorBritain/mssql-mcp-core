import { SQLDialect, SQLSurveyor } from "sql-surveyor";
import { checkColumnPolicy, hasColumnPolicy, type ColumnPolicy } from "./columnPolicy.js";

export interface QueryPolicyResult {
  allowed: boolean;
  query?: string;
  reason?: string;
}

interface QueryPolicy extends ColumnPolicy {
  allowedSchemas?: string[];
  deniedSchemas?: string[];
}

type ParsedTable = {
  tableName: string;
  schemaName?: string | null;
  aliases?: Set<string>;
};

type ParsedColumn = {
  columnName: string;
  tableName?: string | null;
  tableAlias?: string | null;
};

function tableRef(table: ParsedTable): string {
  return `${table.schemaName || "dbo"}.${table.tableName}`;
}

function findTable(tables: ParsedTable[], column: ParsedColumn): ParsedTable | undefined {
  if (column.tableName) {
    return tables.find((table) => table.tableName.toLowerCase() === column.tableName!.toLowerCase());
  }
  if (column.tableAlias) {
    return tables.find((table) => [...(table.aliases ?? [])].some((alias) => alias.toLowerCase() === column.tableAlias!.toLowerCase()));
  }
  return tables.length === 1 ? tables[0] : undefined;
}

function checkParsedColumn(policy: ColumnPolicy, tables: ParsedTable[], column: ParsedColumn): QueryPolicyResult {
  const columnName = column.columnName.trim();
  if (!columnName || columnName === "*" || columnName.endsWith(".*") || /[()+\-/]/.test(columnName)) {
    return { allowed: false, reason: "The query contains a wildcard or derived column that cannot be proven safe under the column policy." };
  }

  const table = findTable(tables, column);
  if (!table) {
    return { allowed: false, reason: `The source table for column '${columnName}' could not be resolved under the column policy.` };
  }

  const decision = checkColumnPolicy(policy, tableRef(table), columnName.split(".").pop()!);
  return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason };
}

function schemaMatches(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

export function enforceQueryColumnPolicy(query: string, policy?: QueryPolicy): QueryPolicyResult {
  if (!policy || (!Object.keys(policy.allowedColumns ?? {}).length && !Object.keys(policy.deniedColumns ?? {}).length && !policy.allowedSchemas?.length && !policy.deniedSchemas?.length)) {
    return { allowed: true, query };
  }

  let parsed: any;
  try {
    const survey = new SQLSurveyor(SQLDialect.TSQL).survey(query) as any;
    parsed = survey?.parsedQueries?.[0];
  } catch {
    return { allowed: false, reason: "The query could not be parsed for column-policy enforcement." };
  }

  if (!parsed || parsed.queryErrors?.length || !parsed.referencedTables) {
    return { allowed: false, reason: "The query could not be parsed for column-policy enforcement." };
  }

  const tables = Object.values(parsed.referencedTables) as ParsedTable[];
  for (const table of tables) {
    const ref = tableRef(table);
    const schema = table.schemaName || "dbo";
    if ((policy.deniedSchemas ?? []).some((pattern) => schemaMatches(schema, pattern) || schemaMatches(ref, pattern))) {
      return { allowed: false, reason: `Schema/table '${ref}' is denied by the environment policy.` };
    }
    if (policy.allowedSchemas?.length && !policy.allowedSchemas.some((pattern) => schemaMatches(schema, pattern) || schemaMatches(ref, pattern))) {
      return { allowed: false, reason: `Schema/table '${ref}' is not in the environment allowlist.` };
    }
  }
  if (tables.some((table) => hasColumnPolicy(policy, tableRef(table)) === false && !table.schemaName)) {
    return { allowed: false, reason: "The query contains an unresolved or unqualified source under the column policy." };
  }

  const outputColumns = (parsed.outputColumns ?? []) as ParsedColumn[];
  const referencedColumns = (parsed.referencedColumns ?? []) as ParsedColumn[];
  for (const column of [...outputColumns, ...referencedColumns]) {
    const table = findTable(tables, column);
    if (table && !hasColumnPolicy(policy, tableRef(table))) continue;
    const result = checkParsedColumn(policy, tables, column);
    if (!result.allowed) return result;
  }

  for (const table of tables) {
    if (hasColumnPolicy(policy, tableRef(table)) && outputColumns.length === 0) {
      return { allowed: false, reason: `The query projection for '${tableRef(table)}' could not be resolved under the column policy.` };
    }
  }

  return { allowed: true, query };
}
