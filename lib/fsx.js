const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

class UnreadableJsonError extends Error {
  constructor(file, why) {
    super(path.basename(file) + " couldn't be read as JSON (" + why + '), so it was left unchanged')
    this.code = 'EUNREADABLEJSON'
    this.file = file
    this.why = why
  }
}

class ConcurrentWriteError extends Error {
  constructor(file) {
    super(path.basename(file) + ' was changed by something else while it was being updated')
    this.code = 'ECONCURRENTWRITE'
    this.file = file
  }
}

function stripBom(s) { return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s }

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))
}

function stamp(file) {
  try {
    const st = fs.statSync(file)
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

function sameStamp(a, b) {
  if (!a || !b) return a === b
  return a.size === b.size && a.mtimeMs === b.mtimeMs
}

function readWithStamp(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const st = fs.fstatSync(fd)
    return { text: fs.readFileSync(fd, 'utf8'), stamp: { size: st.size, mtimeMs: st.mtimeMs } }
  } finally { fs.closeSync(fd) }
}

function readJsonForWrite(file) {
  let got
  try { got = readWithStamp(file) } catch (e) {
    if (e.code === 'ENOENT') return { data: {}, stamp: null }
    throw e
  }
  let data
  try { data = JSON.parse(stripBom(got.text)) } catch (e) { throw new UnreadableJsonError(file, e.message) }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new UnreadableJsonError(file, 'not a JSON object')
  }
  return { data, stamp: got.stamp }
}

function readJsonLoose(file, fallback) {
  try {
    const v = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
    return v === null || v === undefined ? fallback : v
  } catch { return fallback }
}

function writeTarget(file) {
  let st
  try { st = fs.lstatSync(file) } catch { return file }
  if (!st.isSymbolicLink()) return file
  try { return fs.realpathSync(file) } catch {
    return path.resolve(path.dirname(file), fs.readlinkSync(file))
  }
}

function tempName(target) {
  return target + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex')
}

const TEMP_RE = /\.tmp-(\d+)(?:-[0-9a-f]{8})?$/

const RENAME_RETRY_MS = 4000

function renameRetrying(from, to) {
  const deadline = Date.now() + RENAME_RETRY_MS
  for (;;) {
    try { fs.renameSync(from, to); return } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || Date.now() > deadline) throw e
      sleepSync(10 + Math.random() * 30)
    }
  }
}

function writeFileAtomic(file, data, opts) {
  const o = opts || {}
  const target = writeTarget(file)
  fs.mkdirSync(path.dirname(target), { recursive: true })

  let mode = o.mode === undefined ? 0o600 : o.mode
  if (!o.forceMode) {
    try { mode = fs.statSync(target).mode & 0o777 } catch {  }
  }

  if (o.expect !== undefined && !sameStamp(stamp(target), o.expect)) throw new ConcurrentWriteError(file)

  const tmp = tempName(target)
  try {
    const fd = fs.openSync(tmp, 'wx', mode)
    try {
      fs.writeFileSync(fd, data)
      try { fs.fchmodSync(fd, mode) } catch {  }
      if (o.fsync) fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }

    if (o.expect !== undefined && !sameStamp(stamp(target), o.expect)) throw new ConcurrentWriteError(file)
    renameRetrying(tmp, target)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch {  }
    throw e
  }

  if (o.fsync) {
    try {
      const dfd = fs.openSync(path.dirname(target), 'r')
      try { fs.fsyncSync(dfd) } finally { fs.closeSync(dfd) }
    } catch {  }
  }
}

function writeJsonAtomic(file, obj, opts) {
  const o = opts || {}
  const text = JSON.stringify(obj, null, o.indent === undefined ? 2 : o.indent) + (o.newline ? '\n' : '')
  writeFileAtomic(file, text, o)
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

function removeStaleTemps(dir, names) {
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { return 0 }
  let removed = 0
  for (const e of entries) {
    const m = TEMP_RE.exec(e)
    if (!m) continue
    if (names && !names.includes(e.slice(0, m.index))) continue
    if (pidAlive(Number(m[1]))) continue
    try { fs.rmSync(path.join(dir, e), { force: true }); removed++ } catch {  }
  }
  return removed
}

function othersCanRead(file) {
  if (process.platform === 'win32') return 0
  try { return fs.statSync(file).mode & 0o044 } catch { return 0 }
}

module.exports = {
  UnreadableJsonError, ConcurrentWriteError,
  readJsonForWrite, readJsonLoose, writeFileAtomic, writeJsonAtomic,
  stamp, sameStamp, sleepSync, pidAlive, removeStaleTemps, othersCanRead, writeTarget, stripBom,
  TEMP_RE,
}
