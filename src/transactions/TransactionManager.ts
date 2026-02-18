import sql from "mssql";

export interface ActiveTransaction {
  transaction: sql.Transaction;
  environmentName: string;
  startedAt: Date;
  operations: { tool: string; table: string; timestamp: Date }[];
}

/**
 * Creates a sql.Request bound to an active transaction if one exists,
 * otherwise bound to the connection pool.
 */
export function createRequest(params: {
  pool: sql.ConnectionPool;
  transaction?: sql.Transaction;
}): sql.Request {
  return params.transaction
    ? params.transaction.request()
    : new sql.Request(params.pool);
}

/**
 * Manages active transactions per environment.
 * One active transaction per environment at a time.
 * Auto-rollback after configurable timeout (default 5 minutes).
 */
export class TransactionManager {
  private active = new Map<string, ActiveTransaction>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private timeoutMs: number;

  constructor(timeoutMs = 5 * 60 * 1000) {
    this.timeoutMs = timeoutMs;
  }

  async begin(envName: string, pool: sql.ConnectionPool): Promise<void> {
    if (this.active.has(envName)) {
      throw new Error(
        `A transaction is already active for environment '${envName}'. ` +
          `Commit or rollback the current transaction before starting a new one.`,
      );
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    this.active.set(envName, {
      transaction,
      environmentName: envName,
      startedAt: new Date(),
      operations: [],
    });

    // Auto-rollback timer (unref'd so it doesn't keep the process alive)
    const timer = setTimeout(async () => {
      if (this.active.has(envName)) {
        try {
          await this.rollback(envName);
          console.warn(
            `[TransactionManager] Auto-rolled back transaction for '${envName}' after ${this.timeoutMs / 1000}s timeout.`,
          );
        } catch {
          // Transaction may already be dead
        }
      }
    }, this.timeoutMs);
    timer.unref();
    this.timers.set(envName, timer);
  }

  getTransaction(envName: string): ActiveTransaction | undefined {
    return this.active.get(envName);
  }

  hasActiveTransaction(envName: string): boolean {
    return this.active.has(envName);
  }

  recordOperation(envName: string, tool: string, table: string): void {
    const txn = this.active.get(envName);
    if (txn) {
      txn.operations.push({ tool, table, timestamp: new Date() });
    }
  }

  async commit(envName: string): Promise<{ operationCount: number }> {
    const txn = this.active.get(envName);
    if (!txn) {
      throw new Error(`No active transaction for environment '${envName}'.`);
    }

    const operationCount = txn.operations.length;
    try {
      await txn.transaction.commit();
    } finally {
      this.cleanup(envName);
    }
    return { operationCount };
  }

  async rollback(envName: string): Promise<{ operationCount: number }> {
    const txn = this.active.get(envName);
    if (!txn) {
      throw new Error(`No active transaction for environment '${envName}'.`);
    }

    const operationCount = txn.operations.length;
    try {
      await txn.transaction.rollback();
    } finally {
      this.cleanup(envName);
    }
    return { operationCount };
  }

  private cleanup(envName: string): void {
    this.active.delete(envName);
    const timer = this.timers.get(envName);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(envName);
    }
  }
}
