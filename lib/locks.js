const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const fsx = require('./fsx')

const DEFAULT_STALE_MS = 2 * 60 * 1000

function lockPath(root, key) {
  return path.join(root, 'locks', String(key).replace(/[^A-Za-z0-9_.-]/g, '_') + '.lock')
}

function readHolder(file) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch { return null }
  let pid = null
  try {
    const j = JSON.parse(raw)
    if (j && Number.isInteger(j.pid)) pid = j.pid
  } catch {  }
  return { raw, pid }
}

function isStale(file, holder, staleMs) {
  let age
  try { age = Date.now() - fs.statSync(file).mtimeMs } catch { return false }
  if (holder.pid && holder.pid !== process.pid && !fsx.pidAlive(holder.pid)) return true
  if (age > 3 * staleMs) return true
  return !holder.pid && age > staleMs
}

function takeOver(file, holder) {
  const now = readHolder(file)
  if (!now || now.raw !== holder.raw) return
  const aside = file + '.stale-' + crypto.randomBytes(6).toString('hex')
  try { fs.renameSync(file, aside) } catch { return }
  const moved = readHolder(aside)
  if (moved && moved.raw !== holder.raw) {
    try { fs.linkSync(aside, file) } catch {  }
  }
  try { fs.rmSync(aside, { force: true }) } catch {  }
}

function tryAcquire(root, key, staleMs) {
  const file = lockPath(root, key)
  const stale = staleMs || DEFAULT_STALE_MS
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const token = JSON.stringify({ pid: process.pid, token: crypto.randomBytes(8).toString('hex'), at: Date.now() })

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, token, { flag: 'wx' })
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) return null
      if (e.code !== 'EEXIST') throw e
      const holder = readHolder(file)
      if (!holder) continue
      if (!isStale(file, holder, stale)) return null
      takeOver(file, holder)
      continue
    }

    const beat = setInterval(() => {
      try { if (fs.readFileSync(file, 'utf8') === token) { const t = new Date(); fs.utimesSync(file, t, t) } } catch {  }
    }, Math.max(1000, Math.floor(stale / 4)))
    if (beat.unref) beat.unref()

    let released = false
    return () => {
      if (released) return
      released = true
      clearInterval(beat)
      const deadline = Date.now() + 1000
      for (;;) {
        try {
          if (fs.readFileSync(file, 'utf8') === token) fs.rmSync(file, { force: true })
          return
        } catch (e) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || Date.now() > deadline) return
          fsx.sleepSync(10)
        }
      }
    }
  }
  return null
}

async function acquire(root, key, opts) {
  const o = opts || {}
  const deadline = Date.now() + (o.waitMs === undefined ? 45000 : o.waitMs)
  for (;;) {
    const release = tryAcquire(root, key, o.staleMs)
    if (release) return release
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, o.pollMs || 250))
  }
}

function acquireSync(root, key, opts) {
  const o = opts || {}
  const deadline = Date.now() + (o.waitMs === undefined ? 3000 : o.waitMs)
  for (;;) {
    const release = tryAcquire(root, key, o.staleMs)
    if (release) return release
    if (Date.now() >= deadline) return null
    fsx.sleepSync(o.pollMs || 15)
  }
}

function isHeld(root, key, staleMs) {
  const file = lockPath(root, key)
  const holder = readHolder(file)
  return !!holder && !isStale(file, holder, staleMs || DEFAULT_STALE_MS)
}

module.exports = { tryAcquire, acquire, acquireSync, isHeld, lockPath, DEFAULT_STALE_MS }
