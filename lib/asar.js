/**
 * Minimal read/write access to one file inside an Electron `app.asar`.
 *
 * Only `/lib/main.js` is ever read or written. Writes are size-preserving, so
 * the archive's directory offsets stay valid; the entry's SHA-256 digest in the
 * directory is refreshed because Electron checks it when the archive carries
 * integrity metadata.
 *
 * The archive itself is opened as ordinary bytes. A process whose `node:fs` is
 * patched for asar (an Electron Node process) must run with
 * `ELECTRON_NO_ASAR=1` or `process.noAsar = true`; the plugin always spawns this
 * module in a separate child process for exactly that reason.
 *
 * @module dsh-restart/lib/asar
 */

import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, writeSync } from 'node:fs'

/** Expected directory header layout of the archives Electron produces. */
export class AsarLayoutError extends Error {}

/**
 * Read the archive directory and locate `/lib/main.js`.
 * @param asarPath - path to `app.asar`.
 * @returns geometry describing the header and the main.js entry.
 */
export function readArchive(asarPath) {
  const fd = openSync(asarPath, 'r')
  try {
    const prefix = Buffer.alloc(16)
    readSync(fd, prefix, 0, 16, 0)
    const hashSize = prefix.readUInt32LE(0)
    const headerSize = prefix.readUInt32LE(4)
    const jsonSize = prefix.readUInt32LE(12)
    if (hashSize !== 4) throw new AsarLayoutError(`unexpected asar hash header (${String(hashSize)})`)
    if (jsonSize <= 0 || jsonSize > 64 * 1024 * 1024) {
      throw new AsarLayoutError(`unexpected asar directory size (${String(jsonSize)})`)
    }
    if (headerSize < jsonSize) throw new AsarLayoutError('unexpected asar directory layout')
    const headerBytes = Buffer.alloc(jsonSize)
    readSync(fd, headerBytes, 0, jsonSize, 16)
    const headerText = headerBytes.toString('utf8')
    const header = JSON.parse(headerText)
    const entry = header?.files?.lib?.files?.['main.js']
    if (entry === undefined || entry.offset === undefined || entry.size === undefined) {
      throw new AsarLayoutError('lib/main.js is not packed in this archive')
    }
    if (entry.unpacked === true) {
      throw new AsarLayoutError('lib/main.js is unpacked from the archive; this desktop build is not supported')
    }
    return {
      headerSize,
      jsonSize,
      header,
      headerText,
      dataBase: 8 + headerSize,
      offset: Number(entry.offset),
      size: Number(entry.size),
      integrity: entry.integrity,
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Read the packed `/lib/main.js` bytes.
 * @param asarPath - path to `app.asar`.
 * @returns `{ bytes, geometry }`.
 */
export function readMain(asarPath) {
  const geometry = readArchive(asarPath)
  const fd = openSync(asarPath, 'r')
  try {
    const bytes = Buffer.alloc(geometry.size)
    readSync(fd, bytes, 0, geometry.size, geometry.dataBase + geometry.offset)
    return { bytes, geometry }
  } finally {
    closeSync(fd)
  }
}

/**
 * Rewrite the directory integrity digest after the body changed.
 * The digest is 64 lowercase hex characters, so the header keeps its size.
 * @param fd - open archive handle.
 * @param geometry - directory geometry.
 * @param digest - new SHA-256 of the file bytes.
 */
export function writeIntegrity(fd, geometry, digest) {
  const previous = geometry.integrity?.hash
  if (previous === undefined) return
  const oldHash = String(previous)
  if (!/^[0-9a-f]{64}$/iu.test(oldHash)) throw new AsarLayoutError('unexpected asar integrity hash')
  if (oldHash === digest) return
  const replaced = geometry.headerText.replaceAll(`"${oldHash}"`, `"${digest}"`)
  if (replaced.length !== geometry.headerText.length) {
    throw new AsarLayoutError('integrity header rewrite changed its size')
  }
  const parsed = JSON.parse(replaced)
  if (parsed.files.lib.files['main.js'].integrity.hash !== digest) {
    throw new AsarLayoutError('integrity header rewrite did not take effect')
  }
  writeSync(fd, Buffer.from(replaced, 'utf8'), 0, geometry.jsonSize, 16)
}

/**
 * Replace `/lib/main.js` with `bytes` and refresh its integrity digest.
 * The caller must pass exactly `geometry.size` bytes.
 * @param asarPath - path to `app.asar`.
 * @param bytes - new file contents, same length as the packed entry.
 */
export function writeMain(asarPath, bytes) {
  const geometry = readArchive(asarPath)
  if (bytes.length !== geometry.size) {
    throw new AsarLayoutError(
      `refusing to write ${String(bytes.length)} bytes over a ${String(geometry.size)} byte entry`,
    )
  }
  const fd = openSync(asarPath, 'r+')
  try {
    writeSync(fd, bytes, 0, bytes.length, geometry.dataBase + geometry.offset)
    writeIntegrity(fd, geometry, createHash('sha256').update(bytes).digest('hex'))
  } finally {
    closeSync(fd)
  }
}

/**
 * SHA-256 of a buffer, in the lowercase hex form the asar directory stores.
 * @param bytes - file contents.
 */
export function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
