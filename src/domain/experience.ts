import type { Candidate, Json } from './algorithm-wire.js'
import type { TrajectoryReference } from './trajectory.js'

/** Dedicated seed-only memory, never a serialized operator report or provider receipt. */
export interface ExperienceRecord {
  version: 2
  source: { [key: string]: Json }
  candidate: Candidate
  parent: Candidate
  scope: { partition: 'seed'; task_ids: string[]; repetitions: number }
  proposal: { rationale: string; hypothesis: string; semantic_targets: string[] }
  change: Json
  classification: Json
  task_results: Json[]
  modification_use: Json
  verifier_trials: Json[]
  trajectory_refs: TrajectoryReference[]
  digest: string
}
export interface ExperienceSnapshot {
  version: 2
  run_id: string
  source_archive_digest: string
  implementation_identity: string
  records: ExperienceRecord[]
  digest: string
}
export interface ExperienceContext {
  version: 2
  snapshot_digest: string
  implementation_identity: string
  available_records: number
  cards: Json[]
  digest: string
}
