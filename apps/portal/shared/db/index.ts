// Durable-store entry point — the seam between call sites and a concrete driver.
//
// FORWARD-LOOKING foundation. `createProductionStore()` is the ONLY place route
// and worker code should obtain a `ProductionStore`. It returns `null` when no
// database is configured (the current signed-cookie deployment), so every call
// site has a clean "no durable store, use stateless behavior" branch:
//
//   const store = createProductionStore();          // lazy-imported in api/**
//   if (!store) { /* stateless path — unchanged */ }
//   else { /* durable path */ }
//
// This file pulls in the (skeleton) Postgres adapter, which imports no DB
// driver, so it is cheap. When a real driver is added it stays cheap because
// the driver is created lazily inside the adapter, and this factory is itself
// only ever `await import()`-ed from an `api/**` handler AFTER auth.

import type { ProductionStore } from "../production-types";
import { loadDbConfig, type DbConfig } from "./config";
import { PostgresStore } from "./postgres-store";

export { loadDbConfig, isDatabaseConfigured } from "./config";
export type { DbConfig, DbDriver } from "./config";
export { PostgresStore, StoreNotWiredError } from "./postgres-store";

/**
 * Resolve the durable store for this deployment, or `null` when none is
 * configured. Accepts an optional pre-loaded config (tests pass one); defaults
 * to reading the environment.
 */
export function createProductionStore(
  cfg: DbConfig = loadDbConfig(),
): ProductionStore | null {
  switch (cfg.driver) {
    case "postgres":
      return new PostgresStore(cfg);
    case "none":
      return null;
    default: {
      // Exhaustiveness guard: a new driver added to DbDriver must be handled.
      const _never: never = cfg.driver;
      throw new Error(`unsupported db driver: ${String(_never)}`);
    }
  }
}
