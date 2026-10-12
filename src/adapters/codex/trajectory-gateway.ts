import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExperienceSnapshot } from '../../domain/experience.js'
import type { ArtifactReaderDescriptor } from '../../domain/trajectory.js'
import { GearError } from '../../domain/errors.js'
import { readSeedTrajectory } from '../artifacts/access.js'
import { RefineSkillServer } from '../skill/server.js'

/** A per-operation read capability. No project/controller methods are reachable. */
export async function trajectoryGateway(
  root: string,
  runRoot: string,
  snapshot: ExperienceSnapshot,
  descriptor: ArtifactReaderDescriptor,
  python: string,
) {
  const socket = join(root, 't.sock'),
    token = randomUUID(),
    abort = new AbortController()
  let active = 0,
    used = 0
  const server = new RefineSkillServer(socket, {
    maxRequestBytes: 32768,
    async call(method, input) {
      if (method !== 'trajectory.read' || !input || typeof input !== 'object' || Array.isArray(input))
        throw new GearError(
          'trajectory-access-denied',
          'Only the frozen trajectory read capability is available',
        )
      const { token: supplied, ...params } = input as Record<string, unknown>
      if (supplied !== token) throw new GearError('trajectory-access-denied', 'Invalid operation capability')
      if (active >= 4 || used >= 256)
        throw new GearError('trajectory-read-limit', 'Operation trajectory read limit reached')
      active++
      used++
      try {
        return await readSeedTrajectory(runRoot, snapshot, descriptor, params, abort.signal, python)
      } catch (error) {
        throw new GearError(
          error instanceof GearError ? error.code : 'trajectory-read-failed',
          'The authorized trajectory could not be read; check its reference, query and source integrity',
        )
      } finally {
        active--
      }
    },
  })
  await writeFile(join(root, 'experience/gateway.json'), JSON.stringify({ socket, token }), { mode: 0o400 })
  await server.start()
  return {
    socket,
    path: join(root, 'experience/gateway.json'),
    async dispose() {
      abort.abort(new GearError('trajectory-reader-stopped', 'Meta operation finished'))
      await server.dispose()
    },
  }
}
