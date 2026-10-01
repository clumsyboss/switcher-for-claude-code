const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const DEFAULT_STALE_MS = 2 * 60 * 1000

function lockPath(root, key) {
  return path.join(root, 'locks', String(key).replace(/[^A-Za-z0-9_.-]/g, '_') + '.lock')
}

function tryAcquire(root, key, staleMs) {
  const file = lockPath(root, key)
  const stale = staleMs || DEFAULT_STALE_MS
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const token = process.pid + ':' + crypto.randomBytes(8).toString('hex')

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, token, { flag: 'wx' })
      let released = false
      return () => {
        if (released) return
        released = true
        try { if (fs.readFileSync(file, 'utf8') === token) fs.rmSync(file, { force: true }) } catch {  }
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let age
      try { age = Date.now() - fs.statSync(file).mtimeMs } catch { continue }
      if (age <= stale) return null
      try { fs.rmSync(file, { force: true }) } catch {  }
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

function isHeld(root, key, staleMs) {
  try { return Date.now() - fs.statSync(lockPath(root, key)).mtimeMs <= (staleMs || DEFAULT_STALE_MS) } catch { return false }
}

module.exports = { tryAcquire, acquire, isHeld, lockPath, DEFAULT_STALE_MS }
