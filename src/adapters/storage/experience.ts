import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { ExperienceSnapshot } from '../../domain/experience.js'
import { publishFile } from './atomic.js'

export const MAX_EXPERIENCE_BYTES = 12 * 1024 * 1024
export function verifyExperience(snapshot: ExperienceSnapshot, digest: string): void {
  const { digest: actual, ...body } = snapshot
  if (
    snapshot.version !== 2 ||
    actual !== digest ||
    canonicalDigest(body) !== digest ||
    !Array.isArray(snapshot.records) ||
    snapshot.records.length > 4096 ||
    new Set(snapshot.records.map((record) => record.candidate.id)).size !== snapshot.records.length
  )
    throw new GearError('experience-identity-mismatch', 'Frozen experience snapshot changed')
  for (const record of snapshot.records) {
    const { digest: recordDigest, ...recordBody } = record
    if (
      record.version !== 2 ||
      record.scope.partition !== 'seed' ||
      record.candidate.parent_id !== record.parent.id ||
      canonicalDigest(recordBody) !== recordDigest
    )
      throw new GearError('experience-identity-mismatch', 'Frozen seed experience record changed')
  }
}

/** One bounded, immutable sanitized snapshot. Unreferenced files never enter a Meta request. */
export class ExperienceStore {
  constructor(readonly root: string) {}
  private path(digest: string) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
      throw new GearError('invalid-experience-digest', 'Invalid experience snapshot digest')
    return join(this.root, digest.slice(7) + '.json')
  }
  async read(digest: string): Promise<ExperienceSnapshot> {
    const file = await open(this.path(digest), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_EXPERIENCE_BYTES)
        throw new GearError('experience-file-invalid', 'Experience must be a bounded regular file')
      const snapshot = JSON.parse(await file.readFile('utf8')) as ExperienceSnapshot
      verifyExperience(snapshot, digest)
      return snapshot
    } finally {
      await file.close()
    }
  }
  async save(snapshot: ExperienceSnapshot): Promise<void> {
    verifyExperience(snapshot, snapshot.digest)
    const bytes = JSON.stringify(snapshot)
    if (Buffer.byteLength(bytes) > MAX_EXPERIENCE_BYTES)
      throw new GearError(
        'experience-size-limit',
        'Experience snapshot exceeds 12 MiB; raw research remains available',
      )
    try {
      await this.read(snapshot.digest)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await publishFile(this.path(snapshot.digest), bytes, { immutable: true })
  }
}
