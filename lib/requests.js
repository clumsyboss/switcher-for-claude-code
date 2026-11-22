const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const fsx = require('./fsx')
const store = require('./store')
const profiles = require('./profiles')
const logins = require('./logins')
const chatPins = require('./chatpins')

const DIR = 'requests'
const KINDS = ['pinChat', 'unpinChat']
const SESSION = /^[A-Za-z0-9-]{8,64}$/
const ID = /^[0-9a-f]{8,64}$/
const CLAIM_ANY_MS = 10 * 1000
const EXPIRE_MS = 2 * 60 * 1000
const KEEP_MS = 60 * 60 * 1000
const LOGIN_MARGIN_MS = 60 * 60 * 1000
const TOO_BIG_TEXT = 'The request was too big to be one, so it was dropped.'
const EXPIRED_TEXT = 'No VS Code window picked this up. Is VS Code open?'
const MAX_BYTES = 4096
const MAX_PENDING = 50
const ALIVE_MS = 30 * 1000

const STATES = Object.freeze({
  PINNED: 'pinned', WAITING: 'waiting', REOPENED: 'reopened', UNPINNED: 'unpinned',
  NEEDS_REOPEN: 'needs-reopen', FAILED: 'failed', EXPIRED: 'expired',
})
const REASONS = Object.freeze({
  BAD_REQUEST: 'bad-request', BAD_KIND: 'bad-kind', BAD_SESSION: 'bad-session', NO_ACCOUNT: 'no-account',
  NO_PINNING_LOGIN: 'no-pinning-login', LOGIN_ENDED: 'login-ended', TOO_MANY: 'too-many',
})

function dir(root) { return path.join(root, DIR) }
function requestFile(root, id) { return path.join(dir(root), id + '.json') }
function resultFile(root, id) { return path.join(dir(root), id + '.result.json') }
function claimFile(root, id, pid) { return path.join(dir(root), id + '.claimed-' + pid) }
function aliveFile(root, pid) { return path.join(dir(root), '.alive-' + pid + '.json') }
const REQUEST_NAME = /^([0-9a-f]+)\.json$/

function validId(id) { return typeof id === 'string' && ID.test(id) }
function validSession(id) { return typeof id === 'string' && SESSION.test(id) }

function checkAccount(root, account, now) {
  if (!store.validName(account) || !profiles.exists(root, account)) {
    return { ok: false, reason: 'no-account', text: 'There is no saved account called "' + String(account).slice(0, 40) + '".' }
  }
  let w = null
  try { w = logins.wrapperLogin(root, account) } catch { w = null }
  if (!w) return { ok: false, reason: 'no-pinning-login', text: account + ' has no pinning login. Add one in VS Code first.' }
  if (!(w.expiresAt > (now || Date.now()) + LOGIN_MARGIN_MS)) {
    return { ok: false, reason: 'login-ended', text: account + '\'s pinning login has ended. Sign it in again in VS Code first.' }
  }
  return { ok: true }
}

function check(root, req, now) {
  if (!req || typeof req !== 'object') return { ok: false, reason: 'bad-request', text: 'Not a request.' }
  if (!KINDS.includes(req.kind)) return { ok: false, reason: 'bad-kind', text: 'Not something the Switcher can do: ' + String(req.kind).slice(0, 40) + '.' }
  if (!validSession(req.sessionId)) return { ok: false, reason: 'bad-session', text: 'Not a chat id.' }
  if (req.kind === 'pinChat') return checkAccount(root, req.account, now)
  return { ok: true }
}

function submit(root, req) {
  const now = (req && req.now) || Date.now()
  const c = check(root, req, now)
  if (!c.ok) return c
  if (list(root).filter((f) => REQUEST_NAME.test(f)).length >= MAX_PENDING) {
    return { ok: false, reason: 'too-many', text: 'VS Code already has ' + MAX_PENDING + ' requests waiting. Try again in a few minutes.' }
  }
  const id = crypto.randomBytes(16).toString('hex')
  const out = { v: 1, id, kind: req.kind, sessionId: req.sessionId, from: 'hub', at: now }
  if (req.kind === 'pinChat') out.account = req.account
  if (typeof req.device === 'string' && req.device.trim()) out.device = req.device.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60)
  fs.mkdirSync(dir(root), { recursive: true })
  fsx.writeJsonAtomic(requestFile(root, id), out)
  return { ok: true, id }
}

function result(root, id) {
  if (!validId(id)) return null
  const j = fsx.readJsonLoose(resultFile(root, id), null)
  if (!j || typeof j !== 'object' || typeof j.ok !== 'boolean') return null
  return { ok: j.ok, state: typeof j.state === 'string' ? j.state : null, text: typeof j.text === 'string' ? j.text : '', at: j.at || null }
}

function list(root) {
  try { return fs.readdirSync(dir(root)) } catch { return [] }
}

function scan(root, now) {
  const t = now || Date.now()
  const out = []
  for (const f of list(root)) {
    const m = REQUEST_NAME.exec(f)
    if (!m || !validId(m[1])) continue
    const file = path.join(dir(root), f)
    let st = null
    try { st = fs.statSync(file) } catch { continue }
    if (st.size > MAX_BYTES) continue
    const j = fsx.readJsonLoose(file, null)
    if (!j || typeof j !== 'object' || j.id !== m[1]) continue
    const from = typeof j.at === 'number' && Number.isFinite(j.at) ? Math.min(j.at, st.mtimeMs) : st.mtimeMs
    out.push({ ...j, ageMs: t - from })
  }
  return out.sort((a, b) => b.ageMs - a.ageMs)
}

function pending(root, now) { return scan(root, now).slice(0, MAX_PENDING) }

function claim(root, id, pid, o) {
  if (!validId(id)) return null
  const p = pid || process.pid
  const from = requestFile(root, id)
  const to = claimFile(root, id, p)
  try { fs.renameSync(from, to) } catch { return null }
  if (o && o.unread) return {}
  let size = 0
  try { size = fs.statSync(to).size } catch { return null }
  if (size > MAX_BYTES) { finish(root, id, { ok: false, state: 'failed', text: TOO_BIG_TEXT }, p); return null }
  const j = fsx.readJsonLoose(to, null)
  if (!j || typeof j !== 'object') { finish(root, id, { ok: false, state: 'failed', text: 'The request could not be read.' }, p); return null }
  return j
}

function finish(root, id, res, pid) {
  if (!validId(id)) return
  const r = { ok: !!res.ok, state: res.state || (res.ok ? 'done' : 'failed'), text: String(res.text || ''), at: Date.now() }
  fsx.writeJsonAtomic(resultFile(root, id), r)
  try { fs.rmSync(claimFile(root, id, pid || process.pid), { force: true }) } catch {  }
}

function ageOf(file, now) {
  try { return now - fs.statSync(file).mtimeMs } catch { return 0 }
}

function sweep(root, opts) {
  const o = opts || {}
  const now = o.now || Date.now()
  const alive = o.pidAlive || fsx.pidAlive
  const out = { expired: 0, failed: 0, done: 0, removed: 0 }
  for (const f of list(root)) {
    const m = REQUEST_NAME.exec(f)
    if (!m || !validId(m[1])) continue
    let size = 0
    try { size = fs.statSync(path.join(dir(root), f)).size } catch { continue }
    if (size <= MAX_BYTES || !claim(root, m[1], process.pid, { unread: true })) continue
    finish(root, m[1], { ok: false, state: 'failed', text: TOO_BIG_TEXT })
    out.failed++
  }
  for (const r of scan(root, now)) {
    if (r.ageMs < EXPIRE_MS) continue
    if (!claim(root, r.id)) continue
    finish(root, r.id, { ok: false, state: 'expired', text: EXPIRED_TEXT })
    out.expired++
  }
  for (const f of list(root)) {
    const file = path.join(dir(root), f)
    const c = /^([0-9a-f]+)\.claimed-(\d+)$/.exec(f)
    if (c && validId(c[1]) && !alive(Number(c[2]))) {
      if (!fs.existsSync(resultFile(root, c[1]))) {
        const done = doneAnyway(root, file)
        fsx.writeJsonAtomic(resultFile(root, c[1]), { ...(done || { ok: false, state: 'failed', text: 'The VS Code window handling this closed before it finished.' }), at: now })
        if (done) out.done++
        else out.failed++
      }
      try { fs.rmSync(file, { force: true }) } catch {  }
      continue
    }
    const a = /^\.alive-(\d+)\.json$/.exec(f)
    if (a && !alive(Number(a[1]))) {
      try { fs.rmSync(file, { force: true }); out.removed++ } catch {  }
      continue
    }
    if (ageOf(file, now) > KEEP_MS) {
      try { fs.rmSync(file, { force: true }); out.removed++ } catch {  }
    }
  }
  return out
}

function doneAnyway(root, claimed) {
  try { if (fs.statSync(claimed).size > MAX_BYTES) return null } catch { return null }
  const req = fsx.readJsonLoose(claimed, null)
  if (!req || typeof req !== 'object' || !validSession(req.sessionId)) return null
  let pin = null
  try { pin = chatPins.read(root).find((p) => p.id === req.sessionId) || null } catch { return null }
  if (req.kind === 'pinChat' && pin && pin.name === req.account) {
    return { ok: true, state: 'pinned', text: '"' + (pin.title || 'The chat') + '" is pinned to ' + labelOf(root, req.account) +
      '. It moves to it the next time it opens.' }
  }
  if (req.kind === 'unpinChat' && !pin) {
    return { ok: true, state: 'unpinned', text: 'The chat is unpinned. It moves the next time it opens.' }
  }
  return null
}

function labelOf(root, name) {
  try { return store.displayOf(root, name).label || name } catch { return name }
}

function beat(root, o) {
  const opt = o || {}
  const pid = opt.pid || process.pid
  try {
    fs.mkdirSync(dir(root), { recursive: true })
    fsx.writeJsonAtomic(aliveFile(root, pid), { pid, at: opt.now || Date.now(), version: opt.version || null })
  } catch {  }
}

function unbeat(root, pid) {
  try { fs.rmSync(aliveFile(root, pid || process.pid), { force: true }) } catch {  }
}

function alive(root, o) {
  const opt = o || {}
  const now = opt.now || Date.now()
  const isAlive = opt.pidAlive || fsx.pidAlive
  const out = []
  for (const f of list(root)) {
    const m = /^\.alive-(\d+)\.json$/.exec(f)
    if (!m) continue
    const file = path.join(dir(root), f)
    let st = null
    try { st = fs.statSync(file) } catch { continue }
    if (st.size > MAX_BYTES) continue
    const j = fsx.readJsonLoose(file, null)
    const pid = Number(m[1])
    if (!j || j.pid !== pid || typeof j.at !== 'number') continue
    if (now - Math.min(j.at, st.mtimeMs) > ALIVE_MS || !isAlive(pid)) continue
    out.push({ pid, at: j.at, version: typeof j.version === 'string' ? j.version : null })
  }
  return out
}

module.exports = {
  DIR, KINDS, STATES, REASONS, CLAIM_ANY_MS, EXPIRE_MS, KEEP_MS, ALIVE_MS, MAX_BYTES, MAX_PENDING, EXPIRED_TEXT,
  dir, requestFile, resultFile, claimFile, aliveFile, validId, validSession, checkAccount, check,
  submit, result, pending, claim, finish, sweep, beat, unbeat, alive,
}
