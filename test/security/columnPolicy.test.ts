import { describe, expect, it } from "vitest";
import { checkColumnPolicy, filterAllowedColumns, validateColumnNames } from "../../src/security/columnPolicy.js";
import { enforceQueryColumnPolicy } from "../../src/security/queryColumnPolicy.js";

// WHY: column policy is the common boundary for every tool; a precedence or wildcard regression
// would expose sensitive fields even when the environment configuration appears restrictive.
describe("column policy", () => {
  const policy = {
    allowedColumns: { "dbo.Customers": ["Id", "Name", "Secret"] },
    deniedColumns: { "dbo.Customers": ["Secret"] },
  };

  it("denies before evaluating the allowlist", () => {
    expect(checkColumnPolicy(policy, "dbo.Customers", "Secret").allowed).toBe(false);
    expect(checkColumnPolicy(policy, "dbo.Customers", "Name").allowed).toBe(true);
    expect(checkColumnPolicy(policy, "dbo.Customers", "Email").allowed).toBe(false);
  });

  it("filters metadata without changing unrestricted tables", () => {
    expect(filterAllowedColumns(policy, "dbo.Customers", [{ columnName: "Id" }, { columnName: "Secret" }])).toEqual([{ columnName: "Id" }]);
    expect(filterAllowedColumns(undefined, "dbo.Orders", [{ columnName: "Total" }])).toEqual([{ columnName: "Total" }]);
  });

  it("validates all writer columns before execution", () => {
    expect(validateColumnNames(policy, "dbo.Customers", ["Id", "Secret"]).allowed).toBe(false);
  });
});

// WHY: post-query filtering is too late because SELECT expressions and wildcards can leak a
// denied value; parser-backed validation must reject ambiguous projections before SQL executes.
describe("query column policy", () => {
  const policy = { deniedColumns: { "dbo.Customers": ["Secret"] } };

  it("allows an explicit permitted projection", () => {
    expect(enforceQueryColumnPolicy("SELECT Id, Name FROM dbo.Customers", policy).allowed).toBe(true);
  });

  it("rejects an explicit denied projection", () => {
    const result = enforceQueryColumnPolicy("SELECT Id, Secret FROM dbo.Customers", policy);
    expect(result.allowed).toBe(false);
  });

  it("rejects wildcard and derived projections when a policy matches", () => {
    expect(enforceQueryColumnPolicy("SELECT * FROM dbo.Customers", policy).allowed).toBe(false);
    expect(enforceQueryColumnPolicy("SELECT Secret + 'x' FROM dbo.Customers", policy).allowed).toBe(false);
  });

  it("handles aliases and joins without allowing a denied output column", () => {
    const result = enforceQueryColumnPolicy(
      "SELECT c.Id, c.Secret FROM dbo.Customers c JOIN dbo.Orders o ON c.Id = o.CustomerId",
      policy,
    );
    expect(result.allowed).toBe(false);
  });
});
