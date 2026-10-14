# Independent evaluation inference

Gear model evaluation can use the separately installable inference service in `agent-hitch/packages/inference`. Training rollout, policy updates, Slime synchronization and per-episode Hitch execution are unchanged. Harbor/Docker continue to execute tasks and verifiers.

Install the standalone wheel in the model-node interpreter before freezing a new experiment:

```sh
python3 -m pip install '/path/to/agent-hitch/packages/inference[sglang]'
```

Use the same absolute `nodeRoot` and `storeRoot` as the Gear model node. This shares the OS-boot node identity, `device-leases.json`, `device-leases.lock` and archived generation proofs. `deviceLeaseRuntime: "standalone-v1"` in the model-node/job configuration selects the installed shared ownership authority; a missing installation fails explicitly. Existing configs retain the versioned `gear-legacy-v2` adapter and identical ledger schema/locks. Install changes invalidate observed runtime identity, so create a new baseline instead of editing historical state.

For a v2 model-training specification, set `evaluation.inferencePool` explicitly:

```json
{
  "schemaVersion": 3,
  "profile": "baseline",
  "tensorParallelSize": 2,
  "replicas": [
    {"devices": ["GPU-a", "GPU-b"]},
    {"devices": ["GPU-c", "GPU-d"]}
  ],
  "maxRunningRequests": 2,
  "maxQueuedRequests": 2,
  "maxConcurrent": 2,
  "modelNode": {
    "nodeId": "the-frozen-training-node-id",
    "generation": "the-frozen-os-boot-generation",
    "runtimeDigest": "sha256:the-actual-standalone-runtime-digest"
  }
}
```

Read the actual `modelNode` attestation from an independent `hitch-inference plan` lock: its `model_node.node_id`, `generation` and `runtime_digest`. The neutral inference runtime digest may differ from Gear's training runtime digest; both must refer to the same node and boot generation. Never copy the training digest as a substitute for observation. The pool's device set must cover `resources.evaluationDevices` exactly, and its replicas must be disjoint TP-sized groups. `evaluation.samplingProfile` must equal the pool profile. Per-engine SGLang DP=1 and PP=1; TP comes from each explicit UUID group.

The v2 controller keeps `deployment.nodes` for Gear training and publication, including their frozen training attestation. For an independent inference interpreter, add `evaluationNode: { "transport": { "type": "ssh", "host": "gpu-host" }, "python": ["/opt/inference/bin/python"], "configPath": "/workspace/inference-node.json" }` beside `evaluationGateway`. This override accepts only transport, Python argv and config path; the explicit evaluation pool selects the standalone adapter. Its node configuration must share the training node's exact `nodeRoot` and `storeRoot`. Registration checks the frozen node ID, boot generation and inference runtime digest. Without `evaluationNode`, evaluation reuses the training connection coordinates, so that interpreter must have both packages installed. Publication always calls the Gear adapter with the training attestation, even when the connection was marked `runtime: "standalone-v1"` for evaluation. A local evaluation connection requires equal local/node gateway ports; an SSH connection may tunnel different ports.

Set `hitch.budgets.maxConcurrent` to the same value and recompute the complete `evaluation.common.budgetsDigest`. Prepare the baseline through `hitch local plan --pool-file ... --profile ...`; freeze `inferenceCommonDigest(lock)`, protocol and generation digests in the evaluation common conditions. The common digest includes runtime, execution settings, resources, model-node attestation and replica topology, while candidate model weights stay in the evaluation subject. Gear additionally seals `inferencePoolDigest`, so changing capacity, concurrency or topology requires a new baseline and cannot reuse old paired evidence.

The evaluator sends the full pool to Hitch, submits the configured number of simultaneous trials, and records cumulative usage across every replica once. Sequential train/evaluation handoff waits for all inference processes and physical GPUs to be confirmed released before training can acquire the shared pool. Request cancellation only closes that request; releasing a client does not kill a shared deployment. Service draining has a bounded deadline, and stop/reboot recovery retain ownership until process/GPU proof succeeds.

Historical v1/v2 single-GPU locks and results keep their identities and explicit compatibility adapter. Existing evidence is neither widened into a v3 pool nor rewritten. New standalone registrations are used only with the new explicit pool contract. Independently installed ordinary OpenAI inference also works without a Gear experiment.

CPU tests use actual detached fake-engine processes and HTTP sockets. Physical 2-GPU TP=2 and 4-GPU TP=2 with two replicas remain hardware gates; follow the independent package's operator-run smoke commands. These changes do not claim concurrent training rollout or hardware certification.

The real dual-registration regression can be run with `GEAR_TEST_HITCH=/absolute/path/to/hitch GEAR_TEST_INFERENCE_PACKAGE=/absolute/path/to/agent-hitch/packages/inference GEAR_TRAINING_TEST_PYTHON=/absolute/path/to/python npm test -- tests/unit/training/hitch-node-registration.spec.ts`. It launches both RPC implementations and the public Hitch CLI, using package metadata fixtures without starting a GPU engine.
