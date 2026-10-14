import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { digestJson } from '../../../src/training/digest.js'
import { hitchModelNodeBinding, registerHitchModelNode, registerHitchTrainingModelNode } from '../../../src/training/hitch-model-node.js'
import { jsonProcess } from '../../../src/training/process.js'
import { nodeEnvelope } from '../../../src/training/transport.js'

const hitch = process.env.GEAR_TEST_HITCH
const inference = process.env.GEAR_TEST_INFERENCE_PACKAGE
let root: string | undefined
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }) })

it.skipIf(!hitch || !inference)('registers explicit standalone evaluation and Gear publication against their real, distinct attestations', async () => {
  root = await mkdtemp(join(tmpdir(), 'gear-real-node-registration-'))
  const python = process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'
  // Metadata alone is sufficient for RPC capability observation; no GPU engine is launched.
  const metadata = join(root, 'metadata')
  for (const [name, version] of [['sglang', '0.5.15.post1'], ['torch', '2.14.0']]) {
    const directory = join(metadata, `${name}-${version}.dist-info`)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'METADATA'), `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`)
    await writeFile(join(directory, 'RECORD'), '')
  }
  vi.stubEnv('PYTHONPATH', [resolve('python'), join(inference!, 'python'), metadata].join(':'))
  const configPath = join(root, 'node.json')
  await writeFile(configPath, JSON.stringify({ schemaVersion: 2, nodeId: 'same-node', nodeRoot: join(root, 'node'), storeRoot: join(root, 'cas'), inferencePort: 32891 }))
  const probe = async (module: string) => (await jsonProcess([python], ['-m', module, 'rpc', '--config', configPath], nodeEnvelope(null, 'probe', {})) as {
    result: { nodeId: string; generation: string; runtimeDigest: string }
  }).result
  const training = await probe('gear.training.cli.node'), evaluation = await probe('hitch_inference.node')
  expect(evaluation.nodeId).toBe(training.nodeId)
  expect(evaluation.generation).toBe(training.generation)
  expect(evaluation.runtimeDigest).not.toBe(training.runtimeDigest)
  const binding = (observed: typeof training) => hitchModelNodeBinding({ ...observed, nodeRef: 'gpu', launcher: 'process' })
  const options = { command: hitch!.endsWith('.js') ? [process.execPath, hitch!] : [hitch!], root: join(root, 'hitch'), modelNode: {
    transport: { type: 'local' as const }, python: [python], configPath, runtime: 'standalone-v1' as const, gateway: { localPort: 32891, nodePort: 32891 },
  } }
  await registerHitchModelNode(options, binding(evaluation), join(root, 'evaluation'))
  await registerHitchTrainingModelNode(options, binding(training), join(root, 'publication'))
  const registration = JSON.parse(await readFile(join(root, 'publication', 'registration.json'), 'utf8'))
  expect(registration.connection.runtime).toBe('gear-legacy-v2')
  expect(digestJson(registration.binding)).toBe(digestJson(binding(training)))
  await expect(registerHitchModelNode(options, binding(training), join(root, 'wrong-runtime'))).rejects.toMatchObject({ exitCode: 12 })
}, 60_000)
