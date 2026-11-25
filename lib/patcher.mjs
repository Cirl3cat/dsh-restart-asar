#!/usr/bin/env node
/**
 * dsh-restart-asar patcher — inspect or repair the DeepSeek Harness desktop shell.
 *
 * Commands:
 *   status    read-only report of the installed `resources/app.asar`
 *   apply     add the Restart entries when the shell is the known stock layout
 *   restore   write a saved pre-patch `lib/main.js` back (`--original <path>`
 *             installs an explicit stock file instead)
 *
 * Options: `--asar <path>`, `--original <path>`, `--json`, `--dry-run`.
 *
 * The rewrite is byte-length preserving (see `lib/patch.js`), so every other
 * entry offset in the archive stays valid. Writes are serialized by a lock file
 * and flushed, each pre-patch file is saved under
 * `~/.dsh/dsh-restart-asar/backups/<sha256>.js` (keyed by its own digest, so no
 * second archive can replace it, keeping the newest few), and a syntax check
 * runs before anything is written.
 *
 * @module dsh-restart-asar/lib/patcher
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readArchive, readMain, writeMain } from './asar.js'
import { buildPatch, status as textStatus, validatePatched } from './patch.js'

/** Environment variable that points the patcher at another archive. */
export const ASAR_ENV = 'DSH_DESKTOP_APP_ASAR'

/** Environment variable that points the patcher at another state directory. */
export const STATE_ENV = 'DSH_RESTART_ASAR_HOME'

/** The pre-rename state directory variable, still honoured. */
const LEGACY_STATE_ENV = 'DSH_RESTART_HOME'

/** State directory holding the saved originals, the lock, and the last run. */
export function stateDirectory() {
  const fromEnv = process.env[STATE_ENV] ?? process.env[LEGACY_STATE_ENV]
  return typeof fromEnv === 'string' && fromEnv !== ''
    ? fromEnv
    : join(homedir(), '.dsh', 'dsh-restart-asar')
}

/**
 * Move the pre-rename state directory into place once, so the saved original
 * and the last status survive the rename. Only for the default location: an
 * explicit environment variable is used verbatim.
 */
export function migrateLegacyState() {
  if (process.env[STATE_ENV] !== undefined || process.env[LEGACY_STATE_ENV] !== undefined) return
  const before = join(homedir(), '.dsh', 'dsh-restart')
  const after = join(homedir(), '.dsh', 'dsh-restart-asar')
  if (!existsSync(before) || existsSync(after)) return
  try {
    renameSync(before, after)
  } catch {
    /* leave it where it is; the new directory starts empty */
  }
}

/** Bound after which a lock left by a crashed process is taken over. */
const LOCK_STALE_MS = 10 * 60 * 1000

/** Whether a lock file was left behind by a process that no longer exists. */
function lockIsStale(path) {
  let record
  try {
    record = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return true
  }
  const age = Date.now() - Date.parse(String(record?.at ?? ''))
  if (!(age >= 0 && age < LOCK_STALE_MS)) return true
  const pid = record?.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

/**
 * Serialize archive writes across processes: two DSH instances starting at once
 * would otherwise interleave bytes in the same `app.asar`.
 * @returns a function that releases the lock; call it in a `finally`.
 */
export function acquireLock() {
  migrateLegacyState()
  const directory = stateDirectory()
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'patcher.lock')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(path, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() }, null, 2)}\n`, {
        flag: 'wx',
      })
      return () => {
        try {
          rmSync(path, { force: true })
        } catch {
          /* a stale lock is taken over by the next run */
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (!lockIsStale(path)) {
        throw new Error(`another dsh-restart-asar patcher is running (lock: ${path})`)
      }
      try {
        rmSync(path, { force: true })
      } catch {
        /* retried above */
      }
    }
  }
  throw new Error(`could not acquire ${path}`)
}

/** The desktop app's usual per-user installation directory. */
const DEFAULT_INSTALL_SEGMENTS = ['Programs', 'DeepSeek Harness', 'resources', 'app.asar']

/**
 * Locate the desktop `app.asar`.
 *
 * Order: explicit argument, `DSH_DESKTOP_APP_ASAR`, the executable that runs
 * this Host (`DSH_NODE_EXECUTABLE`, which is the Electron binary for a desktop
 * session), this process's own executable, then the standard install folders.
 * @param explicit - caller-supplied path.
 * @returns the first existing candidate, or undefined.
 */
export function resolveAsar(explicit) {
  if (typeof explicit === 'string' && explicit !== '' && existsSync(explicit)) return explicit
  const fromEnv = process.env[ASAR_ENV]
  if (typeof fromEnv === 'string' && fromEnv !== '' && existsSync(fromEnv)) return fromEnv
  const executables = [process.env.DSH_NODE_EXECUTABLE, process.execPath]
  for (const executable of executables) {
    if (typeof executable !== 'string' || executable === '') continue
    const candidate = join(dirname(executable), 'resources', 'app.asar')
    if (existsSync(candidate)) return candidate
  }
  const local = process.env.LOCALAPPDATA
  if (typeof local === 'string' && local !== '') {
    const candidate = join(local, ...DEFAULT_INSTALL_SEGMENTS)
    if (existsSync(candidate)) return candidate
  }
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (typeof root !== 'string' || root === '') continue
    const candidate = join(root, 'DeepSeek Harness', 'resources', 'app.asar')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Directory holding one saved original per pre-patch digest.
 *
 * Backups used to be a single `main.original.js`, so any other archive — a test
 * fixture, a second install — silently replaced the installed app's original
 * and made `restore` impossible. Keying each backup by its own SHA-256 keeps
 * every shell's original safe; the legacy pair is still read for upgrades.
 */
export function backupsDirectory() {
  return join(stateDirectory(), 'backups')
}

/** Read one saved pair, validating that the bytes still match their digest. */
function readSaved(jsPath, metaPath, source) {
  if (!existsSync(jsPath) || !existsSync(metaPath)) return undefined
  let meta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch {
    return undefined
  }
  if (meta === null || typeof meta !== 'object') return undefined
  if (typeof meta.size !== 'number' || typeof meta.sha256 !== 'string') return undefined
  let bytes
  try {
    bytes = readFileSync(jsPath)
  } catch {
    return undefined
  }
  if (bytes.length !== meta.size) return undefined
  if (createHash('sha256').update(bytes).digest('hex') !== meta.sha256) return undefined
  return { bytes, meta, path: jsPath, source }
}

/** Every saved original that still validates, newest first. */
export function listOriginals() {
  const found = []
  const seen = new Set()
  const legacy = readSaved(
    join(stateDirectory(), 'main.original.js'),
    join(stateDirectory(), 'main.original.json'),
    'legacy',
  )
  if (legacy !== undefined) {
    found.push(legacy)
    seen.add(legacy.meta.sha256)
  }
  let names = []
  try {
    names = readdirSync(backupsDirectory())
  } catch {
    names = []
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const stem = name.slice(0, -'.json'.length)
    const entry = readSaved(
      join(backupsDirectory(), `${stem}.js`),
      join(backupsDirectory(), name),
      'keyed',
    )
    if (entry === undefined || seen.has(entry.meta.sha256)) continue
    found.push(entry)
    seen.add(entry.meta.sha256)
  }
  return found.sort((left, right) =>
    String(right.meta.savedAt ?? '').localeCompare(String(left.meta.savedAt ?? '')),
  )
}

/** The saved original that belongs to a shell whose `lib/main.js` is `size` bytes. */
export function findOriginal(asarPath, size) {
  const candidates = listOriginals().filter((entry) => entry.meta.size === size)
  if (candidates.length === 0) return undefined
  return candidates.find((entry) => entry.meta.asar === asarPath) ?? candidates[0]
}

/** Persist the pre-patch `lib/main.js` under its own digest; never replaces another. */
function saveOriginal(asarPath, bytes) {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const directory = backupsDirectory()
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${sha256}.js`)
  const metaPath = join(directory, `${sha256}.json`)
  const existing = readSaved(path, metaPath, 'keyed')
  if (existing !== undefined) return existing
  const meta = { size: bytes.length, sha256, asar: asarPath, savedAt: new Date().toISOString() }
  const temp = `${path}.tmp`
  writeFileSync(temp, bytes)
  renameSync(temp, path)
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
  return { bytes, meta, path, source: 'keyed' }
}

/**
 * Parse the patched file without executing it.
 * @param text - generated `lib/main.js`.
 */
function assertParses(text) {
  const file = join(tmpdir(), `dsh-restart-check-${String(process.pid)}-${String(Date.now())}.mjs`)
  writeFileSync(file, text)
  try {
    execFileSync(process.execPath, ['--check', file], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      windowsHide: true,
    })
  } finally {
    rmSync(file, { force: true })
  }
}

/**
 * Whether the archive's directory digest still matches `lib/main.js`.
 * A mismatch means Electron's asar integrity check will refuse to load the
 * shell, which is worth reporting before the app is restarted.
 * @param geometry - directory geometry from `readArchive`.
 * @param bytes - the packed `lib/main.js` bytes.
 */
function integrityOf(geometry, bytes) {
  const expected = geometry.integrity?.hash
  if (typeof expected !== 'string' || expected === '') return 'missing'
  const digest = createHash('sha256').update(bytes).digest('hex')
  return expected === digest ? 'ok' : 'mismatch'
}

/** How many keyed originals to keep; older shells cannot be restored anyway. */
const KEEP_ORIGINALS = 5

/** Drop the oldest keyed originals beyond `keep`, leaving the legacy pair alone. */
export function pruneOriginals(keep = KEEP_ORIGINALS) {
  const keyed = listOriginals().filter((entry) => entry.source === 'keyed')
  for (const entry of keyed.slice(keep)) {
    try {
      rmSync(entry.path, { force: true })
      rmSync(entry.path.replace(/\.js$/u, '.json'), { force: true })
    } catch {
      /* a leftover backup is harmless */
    }
  }
}

/**
 * Read-only report.
 * @param options - `{ asar }`.
 */
export function status(options = {}) {
  const asar = options.asar ?? resolveAsar()
  if (asar === undefined) {
    return { ok: false, status: 'missing', message: 'app.asar not found; is this the packaged Windows desktop app?' }
  }
  const { bytes, geometry } = readMain(asar)
  const text = bytes.toString('utf8')
  const state = textStatus(text)
  const saved = findOriginal(asar, geometry.size)
  return {
    ok: true,
    status: state,
    asar,
    mainBytes: geometry.size,
    headerBytes: geometry.jsonSize,
    integrity: integrityOf(geometry, bytes),
    backup: listOriginals().length === 0 ? 'none' : 'saved',
    restorable: saved !== undefined,
    ...(saved === undefined ? {} : { backupSize: saved.meta.size, backupAsar: saved.meta.asar }),
    stateDir: stateDirectory(),
  }
}

/**
 * Add the Restart entries when they are missing (caller holds the lock).
 * @param options - `{ asar, dryRun }`.
 */
function applyUnlocked(options = {}) {
  const asar = options.asar ?? resolveAsar()
  if (asar === undefined) {
    return { ok: false, status: 'missing', message: 'app.asar not found; is this the packaged Windows desktop app?' }
  }

  let current
  let geometry
  try {
    ;({ bytes: current, geometry } = readMain(asar))
  } catch (error) {
    return { ok: false, status: 'unsupported', asar, message: messageOf(error) }
  }

  const source = current.toString('utf8')
  let built
  try {
    built = buildPatch(source)
  } catch (error) {
    return { ok: false, status: 'unsupported', asar, message: messageOf(error) }
  }
  if (built.changed === false) {
    return {
      ok: true,
      status: 'already',
      asar,
      mainBytes: geometry.size,
      integrity: integrityOf(geometry, current),
      restorable: findOriginal(asar, geometry.size) !== undefined,
    }
  }
  if (validatePatched(built.text) !== true) {
    return { ok: false, status: 'unsupported', asar, message: 'generated patch failed its own validation' }
  }
  const bytes = Buffer.from(built.text, 'utf8')
  if (bytes.length !== geometry.size) {
    return { ok: false, status: 'unsupported', asar, message: 'generated patch is not length preserving' }
  }
  if (options.dryRun === true) {
    return { ok: true, status: 'dry-run', asar, mainBytes: geometry.size, note: 'patch would apply' }
  }

  try {
    assertParses(built.text)
  } catch (error) {
    return { ok: false, status: 'unsupported', asar, message: `generated shell failed the syntax check: ${messageOf(error)}` }
  }

  const backup = saveOriginal(asar, current)
  try {
    writeMain(asar, bytes)
  } catch (error) {
    try {
      writeMain(asar, current)
    } catch {
      /* the original bytes are on disk for a manual restore */
    }
    return { ok: false, status: 'write-failed', asar, message: messageOf(error) }
  }

  const after = status({ asar })
  if (after.status !== 'patched' || after.integrity === 'mismatch') {
    try {
      writeMain(asar, current)
    } catch {
      /* leave the backup for a manual restore */
    }
    return {
      ok: false,
      status: 'verify-failed',
      asar,
      message:
        after.integrity === 'mismatch'
          ? 'archive integrity digest did not match the written shell; original restored'
          : 'archive does not read back as patched; original restored',
    }
  }

  pruneOriginals()

  return {
    ok: true,
    status: 'patched',
    asar,
    mainBytes: geometry.size,
    integrity: after.integrity,
    digest: createHash('sha256').update(bytes).digest('hex'),
    backup: backup.path,
    restorable: true,
    note: 'quit and reopen DeepSeek Harness to see the new Restart entries',
    saved: backup.meta,
  }
}

/**
 * Apply, holding the cross-process lock so two DSH instances cannot interleave
 * their writes into the same archive.
 * @param options - `{ asar, dryRun }`.
 */
export function apply(options = {}) {
  let release
  try {
    release = acquireLock()
  } catch (error) {
    return { ok: false, status: 'locked', message: messageOf(error) }
  }
  try {
    return applyUnlocked(options)
  } finally {
    release()
  }
}

/**
 * Write the saved pre-patch shell back (caller holds the lock).
 * @param options - `{ asar, original }`; `original` is an explicit stock
 * `lib/main.js` to install instead of a saved backup (for a reinstall or a
 * recovered file).
 */
function restoreUnlocked(options = {}) {
  const asar = options.asar ?? resolveAsar()
  if (asar === undefined) {
    return { ok: false, status: 'missing', message: 'app.asar not found' }
  }
  let geometry
  try {
    geometry = readArchive(asar)
  } catch (error) {
    return { ok: false, status: 'unsupported', asar, message: messageOf(error) }
  }

  let saved
  if (typeof options.original === 'string' && options.original !== '') {
    let bytes
    try {
      bytes = readFileSync(options.original)
    } catch (error) {
      return {
        ok: false,
        status: 'original-missing',
        asar,
        message: `cannot read ${options.original}: ${messageOf(error)}`,
      }
    }
    if (bytes.length !== geometry.size) {
      return {
        ok: false,
        status: 'size-mismatch',
        asar,
        message: `${options.original} is ${String(bytes.length)} bytes but this shell's lib/main.js is ${String(geometry.size)} bytes`,
      }
    }
    if (textStatus(bytes.toString('utf8')) !== 'clean') {
      return {
        ok: false,
        status: 'unsupported',
        asar,
        message: `${options.original} is not the stock shell layout`,
      }
    }
    saved = saveOriginal(asar, bytes)
  } else {
    saved = findOriginal(asar, geometry.size)
  }
  if (saved === undefined) {
    const known = listOriginals().map((entry) => `${String(entry.meta.size)}B from ${String(entry.meta.asar)}`)
    return {
      ok: false,
      status: 'no-backup',
      asar,
      message:
        `no saved original matches this shell (lib/main.js is ${String(geometry.size)} bytes).` +
        (known.length === 0 ? '' : ` Saved originals: ${known.join('; ')}.`) +
        ' Reinstall the desktop app to regenerate one, or pass --original <stock main.js>.',
    }
  }

  const { bytes } = readMain(asar)
  const current = textStatus(bytes.toString('utf8'))
  if (current === 'clean') {
    return { ok: true, status: 'clean', asar, note: 'shell already matches the stock layout; nothing to restore' }
  }
  if (current !== 'patched') {
    return {
      ok: false,
      status: 'unsupported',
      asar,
      message: 'the installed shell is neither the stock layout nor this plugin\'s patch; refusing to overwrite it',
    }
  }
  try {
    writeMain(asar, saved.bytes)
  } catch (error) {
    return { ok: false, status: 'write-failed', asar, message: messageOf(error) }
  }
  const after = status({ asar })
  if (after.status !== 'clean' || after.integrity === 'mismatch') {
    try {
      writeMain(asar, bytes)
    } catch {
      /* best effort */
    }
    return { ok: false, status: 'verify-failed', asar, message: 'archive does not read back as stock; previous bytes restored' }
  }
  return {
    ok: true,
    status: 'restored',
    asar,
    note: 'quit and reopen DeepSeek Harness to drop the Restart entries',
  }
}

/**
 * Restore, holding the cross-process lock.
 * @param options - `{ asar, original }`.
 */
export function restore(options = {}) {
  let release
  try {
    release = acquireLock()
  } catch (error) {
    return { ok: false, status: 'locked', message: messageOf(error) }
  }
  try {
    return restoreUnlocked(options)
  } finally {
    release()
  }
}

/** Stable message for an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  // Electron's Node mode patches `node:fs` so `app.asar` looks like a
  // directory. This process only needs raw bytes, so opt out completely.
  try {
    process.noAsar = true
  } catch {
    /* not Electron */
  }

  const [command = 'status', ...rest] = process.argv.slice(2)
  const asarIndex = rest.indexOf('--asar')
  const asar = asarIndex >= 0 ? rest[asarIndex + 1] : undefined
  const originalIndex = rest.indexOf('--original')
  const original = originalIndex >= 0 ? rest[originalIndex + 1] : undefined
  const json = rest.includes('--json')
  let result
  try {
    if (command === 'apply') result = apply({ asar, dryRun: rest.includes('--dry-run') })
    else if (command === 'restore') result = restore({ asar, original })
    else if (command === 'status') result = status({ asar })
    else throw new Error(`unknown command: ${command}`)
  } catch (error) {
    result = { ok: false, status: 'error', message: messageOf(error) }
  }
  writeFileSync(join(tmpdir(), 'dsh-restart-last-run.json'), `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.ok === true ? 0 : 1
}
