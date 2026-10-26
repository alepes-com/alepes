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
import { DEFAULT_TASK_QUEUE } from "./task-queue";

export interface WorkerOptions {
  connectionString: string;
  /** Pre-built brokerage executor (defaults to the mock). */
  brokerage?: ReturnType<typeof createMockBrokerageExecutor>;
  /** Temporal address, default localhost:7233 (dev server). */
  temporalAddress?: string;
  /**
   * Temporal task queue this worker polls. Defaults to the production/dev
   * shared queue. Certification harnesses MUST pass an isolated, fingerprinted
   * queue (see `certificationTaskQueueName`) so no ordinary or stale worker
   * can consume the certification workflow.
   */
  taskQueue?: string;
}

import {
  appendEvent,
  claimOutbox,
  claimOutboxById,
  executeOrders,
  loadPlan,
  markOutboxDelivered,
  reconcileExecution,
  releaseOutboxClaim,
  updateDisposition,
  verifyPlan,
} from "./activities";

export async function startWorker(opts: WorkerOptions): Promise<Worker> {
  const taskQueue = opts.taskQueue ?? DEFAULT_TASK_QUEUE;
  await runMigrations(opts.connectionString);
  const ports = createPostgresPorts({ connectionString: opts.connectionString });
  initActivities({ ports, brokerage: opts.brokerage ?? createMockBrokerageExecutor() });

  const connection = await NativeConnection.connect({
    address: opts.temporalAddress ?? "localhost:7233",
  });

  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue,
    workflowsPath: require.resolve("./workflows"),
    // Conservative runtime choice for a financial system: keep V8 context
    // reuse OFF. reuseV8Context defaults to true since SDK 1.9.0, and although
    // 1.20.1 fixes the webpack>=5.108 module-cache isolation bug (issue #2170),
    // Alepes has not separately stress-certified the context-reuse path. Explicitly
    // disabling it eliminates cross-workflow module-level state leakage by
    // construction and is the documented safe default until such certification.
    reuseV8Context: false,
    activities: {
      loadPlan,
      verifyPlan,
      appendEvent,
      updateDisposition,
      executeOrders,
      reconcileExecution,
      claimOutbox,
      claimOutboxById,
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
  const taskQueue = process.env.ALEPES_TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE;
  startWorker({ connectionString: cs, taskQueue })
    .then(async (w) => {
      console.log(`Worker listening on task queue: ${taskQueue}`);
      await w.run();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
