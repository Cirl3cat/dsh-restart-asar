import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readArchive, readMain } from '../lib/asar.js'
import { LEGACY_MARK, MARK, buildPatch } from '../lib/patch.js'
import {
  acquireLock,
  apply,
  backupsDirectory,
  listOriginals,
  pruneOriginals,
  restore,
  status,
} from '../lib/patcher.mjs'
import { shellFixture, unknownFixture } from './fixture.mjs'

// The test process is Electron's Node mode, which treats `*.asar` as a
// directory. Opt out so the temporary archives can be read as plain bytes.
process.noAsar = true

// Every test runs against its own state directory: the per-user state holds
// the installed app's saved original, and a fixture written there would make
// the real `restore` fail (and used to overwrite it).
const stateHomes = []

/** Point this test at a fresh state directory. */
function isolateState() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-restart-state-'))
  stateHomes.push(directory)
  process.env.DSH_RESTART_HOME = directory
  return directory
}

test.after(() => {
  for (const directory of stateHomes) rmSync(directory, { recursive: true, force: true })
})

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

/** The stock shell plus trailing padding, so its `main.js` has a distinct size. */
function paddedFixture(extraBytes) {
  return `${shellFixture()}\n// ${'x'.repeat(extraBytes)}`
}

test('status reads a stock archive as clean', () => {
  isolateState()
  const fixture = fixtureArchive(shellFixture())
  try {
    const result = status({ asar: fixture.asar })
    assert.equal(result.ok, true)
    assert.equal(result.status, 'clean')
    assert.equal(result.backup, 'none')
    assert.equal(result.restorable, false)
  } finally {
    fixture.cleanup()
  }
})

test('apply patches in place, keeps the archive size, and updates the digest', () => {
  const state = isolateState()
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
    const current = status({ asar: fixture.asar })
    assert.equal(current.status, 'patched')
    // The saved original goes to the isolated state directory, not the user's.
    assert.equal(current.stateDir, state)
    assert.equal(current.restorable, true)
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
  isolateState()
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
  isolateState()
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

test('a second shell cannot replace another shell\u2019s saved original', () => {
  const state = isolateState()
  const first = fixtureArchive(shellFixture())
  const second = fixtureArchive(paddedFixture(64))
  try {
    const firstOriginal = readFileSync(first.asar)
    assert.equal(apply({ asar: first.asar }).ok, true)
    assert.equal(apply({ asar: second.asar }).ok, true)
    // Both originals coexist, keyed by their own digest.
    assert.equal(readdirSync(join(state, 'backups')).filter((name) => name.endsWith('.js')).length, 2)
    // The first shell still restores from its own original.
    assert.equal(restore({ asar: first.asar }).status, 'restored')
    assert.equal(readFileSync(first.asar).equals(firstOriginal), true)
  } finally {
    first.cleanup()
    second.cleanup()
  }
})

test('restore reports a missing original instead of touching the archive', () => {
  isolateState()
  const fixture = fixtureArchive(paddedFixture(32))
  try {
    const before = readFileSync(fixture.asar)
    const result = restore({ asar: fixture.asar })
    assert.equal(result.ok, false)
    assert.equal(result.status, 'no-backup')
    assert.match(result.message, /Reinstall/)
    assert.equal(readFileSync(fixture.asar).equals(before), true)
  } finally {
    fixture.cleanup()
  }
})

test('a legacy main.original.js pair is still honoured', () => {
  const state = isolateState()
  const fixture = fixtureArchive(shellFixture())
  try {
    const stock = Buffer.from(shellFixture(), 'utf8')
    writeFileSync(join(state, 'main.original.js'), stock)
    writeFileSync(
      join(state, 'main.original.json'),
      `${JSON.stringify({
        size: stock.length,
        sha256: createHash('sha256').update(stock).digest('hex'),
        asar: fixture.asar,
        savedAt: new Date().toISOString(),
      })}\n`,
    )
    const original = readFileSync(fixture.asar)
    assert.equal(apply({ asar: fixture.asar }).ok, true)
    // Drop the new keyed backup so only the legacy pair can satisfy restore.
    rmSync(join(state, 'backups'), { recursive: true, force: true })
    assert.equal(restore({ asar: fixture.asar }).status, 'restored')
    assert.equal(readFileSync(fixture.asar).equals(original), true)
  } finally {
    fixture.cleanup()
  }
})

test('status reports whether the archive digest matches lib/main.js', () => {
  isolateState()
  const fixture = fixtureArchive(shellFixture())
  try {
    assert.equal(status({ asar: fixture.asar }).integrity, 'ok')
    const bytes = readFileSync(fixture.asar)
    bytes[bytes.length - 1] ^= 0xff
    writeFileSync(fixture.asar, bytes)
    assert.equal(status({ asar: fixture.asar }).integrity, 'mismatch')
  } finally {
    fixture.cleanup()
  }
})

test('apply is refused while another patcher holds the lock', () => {
  isolateState()
  const fixture = fixtureArchive(shellFixture())
  try {
    const before = readFileSync(fixture.asar)
    const release = acquireLock()
    try {
      const result = apply({ asar: fixture.asar })
      assert.equal(result.ok, false)
      assert.equal(result.status, 'locked')
      assert.equal(readFileSync(fixture.asar).equals(before), true)
    } finally {
      release()
    }
    // The lock is released again, so a later run succeeds.
    assert.equal(apply({ asar: fixture.asar }).status, 'patched')
  } finally {
    fixture.cleanup()
  }
})

test('a stale lock left by a dead process is taken over', () => {
  isolateState()
  const fixture = fixtureArchive(shellFixture())
  try {
    mkdirSync(backupsDirectory(), { recursive: true })
    writeFileSync(
      join(process.env.DSH_RESTART_HOME, 'patcher.lock'),
      `${JSON.stringify({ pid: 999_999, at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })}\n`,
    )
    assert.equal(apply({ asar: fixture.asar }).status, 'patched')
  } finally {
    fixture.cleanup()
  }
})

test('a shell patched under the old plugin name can still be restored', () => {
  isolateState()
  const fixture = fixtureArchive(shellFixture())
  try {
    const original = readFileSync(fixture.asar)
    assert.equal(apply({ asar: fixture.asar }).ok, true)
    // Replace the archive body with the pre-rename patch, same byte length.
    const stock = shellFixture()
    const legacy = buildPatch(stock).text.replace(MARK, LEGACY_MARK)
    const padded = legacy + ' '.repeat(Buffer.byteLength(stock, 'utf8') - Buffer.byteLength(legacy, 'utf8'))
    assert.equal(Buffer.byteLength(padded, 'utf8'), Buffer.byteLength(stock, 'utf8'))
    writeFileSync(fixture.asar, packAsar(padded))
    assert.equal(status({ asar: fixture.asar }).status, 'patched')
    const result = restore({ asar: fixture.asar })
    assert.equal(result.ok, true, result.message)
    assert.equal(readFileSync(fixture.asar).equals(original), true)
  } finally {
    fixture.cleanup()
  }
})

test('pruning keeps the newest originals and never the legacy pair', () => {
  const state = isolateState()
  mkdirSync(backupsDirectory(), { recursive: true })
  for (let index = 0; index < 7; index += 1) {
    const bytes = Buffer.from(`shell ${String(index)}`, 'utf8')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(join(backupsDirectory(), `${sha256}.js`), bytes)
    writeFileSync(
      join(backupsDirectory(), `${sha256}.json`),
      `${JSON.stringify({
        size: bytes.length,
        sha256,
        asar: `C:/fake/shell-${String(index)}/app.asar`,
        savedAt: new Date(Date.now() - (7 - index) * 60_000).toISOString(),
      })}\n`,
    )
  }
  const legacy = Buffer.from('legacy', 'utf8')
  writeFileSync(join(state, 'main.original.js'), legacy)
  writeFileSync(
    join(state, 'main.original.json'),
    `${JSON.stringify({
      size: legacy.length,
      sha256: createHash('sha256').update(legacy).digest('hex'),
      asar: 'C:/fake/legacy/app.asar',
      savedAt: new Date(0).toISOString(),
    })}\n`,
  )
  pruneOriginals(5)
  assert.equal(listOriginals().filter((entry) => entry.source === 'keyed').length, 5)
  assert.equal(listOriginals().some((entry) => entry.source === 'legacy'), true)
})

test('restore --original installs an explicit stock file', () => {
  isolateState()
  const fixture = fixtureArchive(shellFixture())
  const stockDir = mkdtempSync(join(tmpdir(), 'dsh-restart-stock-'))
  const stockFile = join(stockDir, 'main.js')
  try {
    const stock = Buffer.from(shellFixture(), 'utf8')
    writeFileSync(stockFile, stock)
    const original = readFileSync(fixture.asar)
    assert.equal(apply({ asar: fixture.asar }).ok, true)
    const result = restore({ asar: fixture.asar, original: stockFile })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.status, 'restored')
    assert.equal(readFileSync(fixture.asar).equals(original), true)
    assert.equal(status({ asar: fixture.asar }).status, 'clean')
  } finally {
    fixture.cleanup()
    rmSync(stockDir, { recursive: true, force: true })
  }
})
