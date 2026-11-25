import assert from 'node:assert/strict'
import test from 'node:test'

import { MARK, buildPatch, status, trimRegionMarkers, validatePatched } from '../lib/patch.js'
import { shellFixture, unknownFixture } from './fixture.mjs'

test('stock fixture is recognised as clean', () => {
  assert.equal(status(shellFixture()), 'clean')
})

test('buildPatch inserts both entries, keeps the byte length, and validates', () => {
  const source = shellFixture()
  const built = buildPatch(source)
  assert.equal(built.changed, true)
  assert.equal(Buffer.byteLength(built.text, 'utf8'), Buffer.byteLength(source, 'utf8'))
  assert.equal(status(built.text), 'patched')
  assert.equal(validatePatched(built.text), true)
  assert.equal(built.text.split(MARK).length - 1, 1)
  assert.match(built.text, /label: currentDesktopLocale\(\)\.messages\.restartApplication/)
  assert.match(built.text, /messages\.restartApplication \+ " " \+ messages\.aboutProduct/)
  assert.match(built.text, /restart: \(\) => \{\n\t\t\t\tvoid restartApplication\(\);/)
  // Menu order: separator -> restart -> quit.
  const menu = built.text.slice(built.text.indexOf('...hideCommands'))
  assert.ok(menu.indexOf('restartApplication') < menu.indexOf('role: "quit"'))
})

test('patching twice is a no-op', () => {
  const once = buildPatch(shellFixture())
  const twice = buildPatch(once.text)
  assert.equal(twice.changed, false)
  assert.equal(twice.text, once.text)
})

test('unknown shell layouts are refused without producing text', () => {
  const source = unknownFixture()
  assert.equal(status(source), 'unsupported')
  assert.throws(() => buildPatch(source), /layout is not the expected desktop shell/u)
})

test('region markers are dropped only as needed', () => {
  const text = '//#region a\nx\n//#endregion\n//#region b\ny\n//#endregion\n'
  const trimmed = trimRegionMarkers(text, 10)
  assert.equal(trimmed.freed >= 10, true)
  assert.equal(trimmed.text.includes('//#region a'), false)
  assert.equal(trimmed.text.includes('//#region b'), true)
  assert.equal(trimmed.text.includes('x'), true)
})

test('generated code stays syntactically valid JS', async () => {
  const { writeFileSync, rmSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { text } = buildPatch(shellFixture())
  const file = join(tmpdir(), `dsh-restart-fixture-${String(process.pid)}.mjs`)
  writeFileSync(file, text)
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' })
  } finally {
    rmSync(file, { force: true })
  }
})
