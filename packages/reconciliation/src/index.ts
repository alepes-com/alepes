// Provider-neutral reconciliation + Shadow Mode composition.
// Pure orchestration — no SQL, no provider SDK, no React.
export { syncAccount } from "./sync-orchestrator";
export type { SyncRun, SyncOrchestratorOptions } from "./sync-orchestrator";
export {
  runShadowMode,
  cashEventIdForObservation,
  totalShadowDeployable,
  ShadowProvenanceError,
} from "./shadow";
export type {
  ShadowDecision,
  ShadowProvenance,
  ShadowModeInput,
} from "./shadow";