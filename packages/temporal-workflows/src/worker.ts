/**
 * Temporal worker entrypoint for Alepes execution plans.
 *
 * Responsibilities:
 *  - wire persistence ports + brokerage capability
 *  - register workflows + activities with Temporal
 *  - start polling the `alepes-execution` task queue
 *
 * Run (production/dev):
 *   ALEPES_DATABASE_URL=... tsx src/worker.ts
 *
 * This file is the only place where infrastructure is assembled. Workflow and
 * activity code stay pure and testable.
 */

import { NativeConnection, Worker } from "@temporalio/worker";
import { createPostgresPorts, runMigrations } from "@alepes/persistence";
import { initActivities } from "./activities";
import { createMockBrokerageExecutor } from "./brokerage";

const TASK_QUEUE = "alepes-execution";

export interface WorkerOptions {
  connectionString: string;
  /** Pre-built brokerage executor (defaults to the mock). */
  brokerage?: ReturnType<typeof createMockBrokerageExecutor>;
  /** Temporal address, default localhost:7233 (dev server). */
  temporalAddress?: string;
}

import {
  appendEvent,
  claimOutbox,
  executeOrders,
  loadPlan,
  markOutboxDelivered,
  reconcileExecution,
  releaseOutboxClaim,
  updateDisposition,
  verifyPlan,
} from "./activities";

export async function startWorker(opts: WorkerOptions): Promise<Worker> {
  await runMigrations(opts.connectionString);
  const ports = createPostgresPorts({ connectionString: opts.connectionString });
  initActivities({ ports, brokerage: opts.brokerage ?? createMockBrokerageExecutor() });

  const connection = await NativeConnection.connect({
    address: opts.temporalAddress ?? "localhost:7233",
  });

  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("./workflows"),
    activities: {
      loadPlan,
      verifyPlan,
      appendEvent,
      updateDisposition,
      executeOrders,
      reconcileExecution,
      claimOutbox,
      markOutboxDelivered,
      releaseOutboxClaim,
    },
  });

  return worker;
}

// Allow `tsx src/worker.ts` to run the worker directly.
if (require.main === module) {
  const cs = process.env.ALEPES_DATABASE_URL;
  if (!cs) {
    console.error("ALEPES_DATABASE_URL is required");
    process.exit(1);
  }
  startWorker({ connectionString: cs })
    .then(async (w) => {
      console.log(`Worker listening on task queue: ${TASK_QUEUE}`);
      await w.run();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
