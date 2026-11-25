import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readArchive, readMain } from '../lib/asar.js'
import { apply, restore, status } from '../lib/patcher.mjs'
import { shellFixture, unknownFixture } from './fixture.mjs'

// The test process is Electron's Node mode, which treats `*.asar` as a
// directory. Opt out so the temporary archives can be read as plain bytes.
process.noAsar = true

/** Build a minimal but layout-correct asar containing only `lib/main.js`. */
function packAsar(mainText) {
  const bytes = Buffer.from(mainText, 'utf8')
  const digest = createHash('sha256').update(bytes).digest('hex')
  const header = {
    files: {
      lib: {
        files: {
          'main.js': {
            size: bytes.length,
            offset: '0',
            integrity: { algorithm: 'SHA256', hash: digest, blockSize: 4194304, blocks: [digest] },
          },
        },
      },
    },
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const jsonSize = json.length
  const headerSize = 8 + Math.ceil(jsonSize / 4) * 4
  const dataBase = 8 + headerSize
  const archive = Buffer.alloc(dataBase + bytes.length)
  archive.writeUInt32LE(4, 0)
  archive.writeUInt32LE(headerSize, 4)
  archive.writeUInt32LE(jsonSize + 4, 8)
  archive.writeUInt32LE(jsonSize, 12)
  json.copy(archive, 16)
  bytes.copy(archive, dataBase)
  return archive
}

/** Create a temp working directory with one archive. */
function fixtureArchive(mainText) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-restart-test-'))
  const asar = join(directory, 'app.asar')
  writeFileSync(asar, packAsar(mainText))
  return { directory, asar, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

test('status reads a stock archive as clean', () => {
  const fixture = fixtureArchive(shellFixture())
  try {
    const result = status({ asar: fixture.asar })
    assert.equal(result.ok, true)
    assert.equal(result.status, 'clean')
  } finally {
    fixture.cleanup()
  }
})

test('apply patches in place, keeps the archive size, and updates the digest', () => {
  const fixture = fixtureArchive(shellFixture())
  try {
    const before = readFileSync(fixture.asar)
    const result = apply({ asar: fixture.asar })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.status, 'patched')

    const after = readFileSync(fixture.asar)
    assert.equal(after.length, before.length)
    const geometry = readArchive(fixture.asar)
    const { bytes } = readMain(fixture.asar)
    assert.equal(status({ asar: fixture.asar }).status, 'patched')
    assert.equal(geometry.size, bytes.length)
    const digest = createHash('sha256').update(bytes).digest('hex')
    assert.equal(geometry.integrity.hash, digest)
    assert.equal(geometry.integrity.blocks[0], digest)
    // Idempotent second run.
    assert.equal(apply({ asar: fixture.asar }).status, 'already')
  } finally {
    fixture.cleanup()
  }
})

test('restore writes the exact original bytes back', () => {
  const fixture = fixtureArchive(shellFixture())
  try {
    const original = readFileSync(fixture.asar)
    assert.equal(apply({ asar: fixture.asar }).ok, true)
    const result = restore({ asar: fixture.asar })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.status, 'restored')
    assert.equal(readFileSync(fixture.asar).equals(original), true)
    assert.equal(status({ asar: fixture.asar }).status, 'clean')
    // Restoring a clean shell is a no-op.
    assert.equal(restore({ asar: fixture.asar }).status, 'clean')
  } finally {
    fixture.cleanup()
  }
})

test('an unknown shell is left untouched', () => {
  const fixture = fixtureArchive(unknownFixture())
  try {
    const before = readFileSync(fixture.asar)
    const result = apply({ asar: fixture.asar })
    assert.equal(result.ok, false)
    assert.equal(result.status, 'unsupported')
    assert.equal(readFileSync(fixture.asar).equals(before), true)
  } finally {
    fixture.cleanup()
  }
})
