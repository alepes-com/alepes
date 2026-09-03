// DuckDB engine for Alepes analytics.
// Currently unavailable under Bun (see README). This module is the runtime
// adapter, but it throws if invoked until Bun bridging works.

import type { AuditRecord } from "@alepes/domain";
import { NullEngine } from "./engine";

export class DuckDBEngine extends NullEngine {
  constructor() {
    super();
    throw new Error("DuckDBEngine is not available in this environment. See README.");
  }
}