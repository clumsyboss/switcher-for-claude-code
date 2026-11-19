const fs = require('fs')
const path = require('path')

const credstore = require('./credstore')
const fsx = require('./fsx')
const locks = require('./locks')
const profiles = require('./profiles')
const secrets = require('./secrets')
const store = require('./store')
const tracker = require('./tracker')
const windows = require('./windows')

const DAY = 24 * 3600 * 1000
const SOON_MS = 5 * DAY
const LAST_DAY_MS = DAY
const REMIND_3_DAYS_MS = 3 * DAY
const SNOOZE_MS = DAY
const WRAPPER_MARGIN_MS = 60 * 60 * 1000
const VERIFY_DELAY_MS = 3000
const LOCK_WAIT_MS = 45000
const INUSE = '.inuse'
const JOURNAL_EXT = '.exchange.enc'

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pinningRoot(root) { return path.join(root, 'pinning') }

function checkName(name) {
  if (!store.validName(name)) throw new Error('Invalid account name for a pinning login: ' + name)
  return name
}

function dirFor(root, name) { return path.join(root, 'pinning', checkName(name)) }
function metaFile(root, name) { return path.join(root, 'pinning', checkName(name) + '.json') }
function inUseDir(root) { return path.join(root, 'pinning', INUSE) }

function readMeta(root, name) {
  const m = fsx.readJsonLoose(metaFile(root, name), null)
  return isObj(m) ? m : null
}

function writeMeta(root, name, meta) {
  fsx.writeFileAtomic(metaFile(root, name), JSON.stringify(meta, null, 2), { mode: 0o600, forceMode: true })
}

function ensurePinningRoot(root) {
  const dir = pinningRoot(root)
  if (fs.existsSync(dir)) return dir
  fs.mkdirSync(dir, { recursive: true })
  store.lockdown(dir)
  return dir
}

function names(root) {
  let files = []
  try { files = fs.readdirSync(pinningRoot(root)) } catch { return [] }
  return files.filter((f) => f.endsWith('.json') && !f.endsWith('.settings.json')).map((f) => f.slice(0, -5))
    .filter((n) => store.validName(n)).sort()
}

function oauthOf(creds) { return (creds && isObj(creds.claudeAiOauth) && creds.claudeAiOauth) || null }
function rtOf(creds) { const o = oauthOf(creds); return (o && o.refreshToken) || null }
const endOf = (creds) => profiles.loginExpiresAt(creds)

function valid(creds, now) {
  if (!rtOf(creds)) return false
  const end = endOf(creds)
  return end === null || end > now
}

function whose(x, a, b) {
  if (!rtOf(x)) return 'none'
  if (rtOf(x) === rtOf(a)) return 'A'
  if (rtOf(x) === rtOf(b)) return 'B'
  const ea = endOf(a)
  const eb = endOf(b)
  if (ea && eb && ea !== eb) {
    if (endOf(x) === ea) return 'A'
    if (endOf(x) === eb) return 'B'
    return 'other'
  }
  return 'unknown'
}

function writeVerified(configDir, creds, o) {
  credstore.write(configDir, creds, o)
  const back = credstore.read(configDir, o)
  if (rtOf(back) !== rtOf(creds)) {
    throw new Error('Wrote a login to ' + credstore.describe(configDir, o) + ' but could not read the same login back.')
  }
}

function identityIn(dir) {
  const j = fsx.readJsonLoose(path.join(dir, '.claude.json'), null)
  return j && isObj(j.oauthAccount) ? j.oauthAccount : null
}

function whoOf(oauthAccount) {
  const o = oauthAccount || {}
  return {
    accountUuid: typeof o.accountUuid === 'string' && o.accountUuid ? o.accountUuid : null,
    email: typeof o.emailAddress === 'string' && o.emailAddress ? o.emailAddress : null,
  }
}

function metaFor(oauthAccount, creds, signedInAt, fallback) {
  const o = oauthAccount || {}
  const f = fallback || {}
  const str = (v) => (typeof v === 'string' && v ? v : null)
  return {
    v: 1,
    accountUuid: str(o.accountUuid) || f.accountUuid || null,
    email: str(o.emailAddress) || f.email || null,
    orgUuid: str(o.organizationUuid) || f.orgUuid || null,
    orgName: str(o.organizationName) || f.orgName || f.org || null,
    plan: profiles.planOf(o, creds) || f.plan || null,
    signedInAt: Number.isFinite(signedInAt) ? signedInAt : null,
    expiresAt: endOf(creds),
  }
}

function daysLeft(expiresAt, now) {
  if (!expiresAt) return null
  return Math.max(0, Math.floor((expiresAt - now) / DAY))
}

function stateOf(expiresAt, now) {
  if (!expiresAt) return 'ok'
  const left = expiresAt - now
  if (left <= 0) return 'expired'
  if (left < LAST_DAY_MS) return 'last-day'
  if (left < SOON_MS) return 'soon'
  return 'ok'
}

function info(root, name, now) {
  let m
  try { m = readMeta(root, name) } catch { return null }
  if (!m || isObj(m.foreign) || m.retired) return null
  const t = now || Date.now()
  const expiresAt = typeof m.expiresAt === 'number' && m.expiresAt > 0 ? m.expiresAt : null
  return {
    expiresAt, daysLeft: daysLeft(expiresAt, t), state: stateOf(expiresAt, t),
    email: m.email || null, accountUuid: m.accountUuid || null,
  }
}

function wrapperLogin(root, name) {
  const i = info(root, name)
  return i && i.expiresAt ? { expiresAt: i.expiresAt, dir: dirFor(root, name) } : null
}

function hasLogin(root, name, opts) {
  try { return credstore.exists(dirFor(root, name), opts) } catch { return false }
}

async function withLock(root, name, opts, fn) {
  const o = opts || {}
  const release = o.lock ? await o.lock(name)
    : await locks.acquire(root, tracker.accountLock(name), { waitMs: o.waitMs === undefined ? LOCK_WAIT_MS : o.waitMs, staleMs: tracker.LOCK_STALE_MS })
  if (!release) return { ok: false, reason: 'locked' }
  try { return await fn() } finally { release() }
}

function expectedWho(root, name, expected) {
  if (isObj(expected)) return { accountUuid: expected.accountUuid || null, email: expected.email || null }
  const n = typeof expected === 'string' ? expected : name
  if (!profiles.exists(root, n)) return null
  const w = profiles.savedWho(root, n)
  return w.accountUuid || w.email ? w : null
}

function readSignIn(fromConfigDir, o) {
  const creds = credstore.read(fromConfigDir, o)
  if (!rtOf(creds)) return { error: { ok: false, reason: 'no-login' } }
  const oauthAccount = identityIn(fromConfigDir)
  const who = whoOf(oauthAccount)
  if (!who.accountUuid && !who.email) return { error: { ok: false, reason: 'no-identity' } }
  return { creds, oauthAccount, who }
}

function importLocked(root, name, fromConfigDir, expected, o) {
  const got = readSignIn(fromConfigDir, o)
  if (got.error) return got.error
  const want = expectedWho(root, name, expected)
  if (want && !profiles.sameAccount(want, got.who)) return { ok: false, reason: 'different-account', who: got.who }

  ensurePinningRoot(root)
  const dir = dirFor(root, name)
  fs.mkdirSync(dir, { recursive: true })
  writeVerified(dir, got.creds, o)
  credstore.remove(fromConfigDir, o)
  const now = (o && o.now) || Date.now()
  writeMeta(root, name, metaFor(got.oauthAccount, got.creds, now))
  return { ok: true, expiresAt: endOf(got.creds), email: got.who.email, accountUuid: got.who.accountUuid }
}

async function importPinning(root, name, fromConfigDir, opts) {
  const o = opts || {}
  checkName(name)
  return withLock(root, name, o, () => importLocked(root, name, fromConfigDir, o.expected, o))
}

async function remove(root, name, opts) {
  checkName(name)
  return withLock(root, name, opts, () => {
    const had = credstore.remove(dirFor(root, name), opts)
    const hadMeta = fs.existsSync(metaFile(root, name))
    fs.rmSync(metaFile(root, name), { force: true })
    try { fs.rmdirSync(dirFor(root, name)) } catch {  }
    return { ok: true, removed: !!(had || hadMeta) }
  })
}

async function setPinningLogin(root, name, creds, oauthAccount, opts) {
  const o = opts || {}
  checkName(name)
  if (!rtOf(creds)) return { ok: false, reason: 'no-login' }
  const now = o.now || Date.now()
  if (!valid(creds, now)) return { ok: false, reason: 'ended' }
  return withLock(root, name, o, () => {
    ensurePinningRoot(root)
    const dir = dirFor(root, name)
    fs.mkdirSync(dir, { recursive: true })
    let held = null
    try { held = credstore.read(dir, o) } catch { held = null }
    const same = rtOf(held) && (rtOf(held) === rtOf(creds) || (endOf(held) && endOf(held) === endOf(creds)))
    if (!same) writeVerified(dir, creds, o)
    const saved = profiles.exists(root, name) ? profiles.readMeta(root, name) : {}
    writeMeta(root, name, metaFor(oauthAccount, same ? held : creds, now,
      { accountUuid: saved.accountUuid, email: saved.email, orgName: saved.org, plan: saved.plan }))
    return { ok: true, expiresAt: endOf(same ? held : creds) }
  })
}

function liveIsAccount(root, name, o) {
  const id = profiles.currentIdentity(o)
  return profiles.activeProfile(root, o) === name && !!id
}

function journalFile(root, name) { return path.join(root, 'pinning', checkName(name) + JOURNAL_EXT) }

function writeJournal(root, name, j) {
  fsx.writeFileAtomic(journalFile(root, name), secrets.protect(Buffer.from(JSON.stringify(j), 'utf8')),
    { mode: 0o600, forceMode: true, fsync: true })
}

function readJournal(root, name) {
  let blob
  try { blob = fs.readFileSync(journalFile(root, name)) } catch { return null }
  return JSON.parse(secrets.unprotect(blob).toString('utf8'))
}

function dropJournal(root, name) { fs.rmSync(journalFile(root, name), { force: true }) }

function step(o, at) {
  if (o && o.onStep) o.onStep(at)
  if (o && o.crashAt === at) throw new Error('simulated crash at ' + at)
}

function slots(root, name, o, active) {
  const dir = dirFor(root, name)
  return {
    readMain: () => (active ? credstore.read(null, o) : profiles.readPayload(root, name).credentials),
    writeMain: (creds) => {
      if (active) writeVerified(null, creds, o)
      else profiles.updateCredentials(root, name, creds)
    },
    readPin: () => credstore.read(dir, o),
    writePin: (creds) => writeVerified(dir, creds, o),
  }
}

function settle(s, A, B) {
  const M = s.readMain()
  const P = s.readPin()
  const m = whose(M, A, B)
  const p = whose(P, A, B)
  if (m === 'B' && p === 'A') return 'exchanged'
  if (m === 'A' && p === 'B') return 'rolled-back'
  if (m !== p || (m !== 'A' && m !== 'B')) return 'unsettled'
  const X = m === 'A' ? A : B
  const mainExact = rtOf(M) === rtOf(X)
  const pinExact = rtOf(P) === rtOf(X)
  let xInMain
  if (pinExact && !mainExact) xInMain = true
  else if (mainExact && !pinExact) xInMain = false
  else xInMain = X === A
  if (xInMain) s.writePin(X === A ? B : A)
  else s.writeMain(X === A ? B : A)
  return (xInMain ? X === B : X === A) ? 'exchanged' : 'rolled-back'
}

function afterExchange(root, name, j, o, active) {
  const pin = credstore.read(dirFor(root, name), o)
  const pinIsA = whose(pin, j.A, j.B) === 'A'
  if (active) {
    try { profiles.capture(root, name, o) } catch (e) { if (o.log) o.log('saving "' + name + '" after the exchange: ' + e.message) }
  }
  if (rtOf(pin)) {
    const m = metaFor(j.oauthAccount, pin, pinIsA ? j.aSignedIn : j.bSignedIn, j.fallback)
    if (j.retire && pinIsA) m.retired = true
    writeMeta(root, name, m)
  }
  try {
    const pm = profiles.readMeta(root, name)
    pm.signedInAt = pinIsA ? j.bSignedIn : j.aSignedIn
    profiles.writeMeta(root, name, pm)
  } catch {  }
  return pin
}

function recoverLocked(root, name, o) {
  let j
  try { j = readJournal(root, name) } catch (e) { return { name, action: 'error', detail: 'the exchange journal could not be read: ' + e.message } }
  if (!j) return { name, action: 'nothing' }
  const active = !!j.active && liveIsAccount(root, name, o)
  let outcome
  try { outcome = settle(slots(root, name, o, active), j.A, j.B) } catch (e) { return { name, action: 'error', detail: e.message } }
  afterExchange(root, name, j, o, active)
  dropJournal(root, name)
  return { name, action: outcome === 'exchanged' ? 'finished' : outcome === 'rolled-back' ? 'rolled-back' : 'left' }
}

async function recover(root, opts) {
  const o = { waitMs: 0, ...(opts || {}) }
  let files = []
  try { files = fs.readdirSync(pinningRoot(root)) } catch { return [] }
  const out = []
  for (const f of files.sort()) {
    if (!f.endsWith(JOURNAL_EXT)) continue
    const name = f.slice(0, -JOURNAL_EXT.length)
    if (!store.validName(name)) continue
    const r = await withLock(root, name, o, () => recoverLocked(root, name, o))
    out.push(r.ok === false && r.reason === 'locked' ? { name, action: 'locked' } : r)
  }
  return out
}

async function exchangeLocked(root, name, o) {
  const prior = recoverLocked(root, name, o)
  if (prior.action === 'error') return { ok: false, reason: 'error', detail: prior.detail }

  const dir = dirFor(root, name)
  if (!profiles.exists(root, name)) return { ok: false, reason: 'no-main' }
  const pinMeta = readMeta(root, name) || {}
  if (isObj(pinMeta.foreign) || pinMeta.retired) return { ok: false, reason: 'no-pinning' }
  const B = credstore.read(dir, o)
  if (!rtOf(B)) return { ok: false, reason: 'no-pinning' }
  if (o.retire && !valid(B, o.now || Date.now())) return { ok: false, reason: 'ended' }

  const active = liveIsAccount(root, name, o)
  if (typeof o.active === 'boolean' && o.active !== active) {
    return { ok: false, reason: 'conflict', detail: 'the active account changed' }
  }
  const saved = profiles.savedWho(root, name)
  const pinWho = { accountUuid: pinMeta.accountUuid || null, email: pinMeta.email || null }
  if ((pinWho.accountUuid || pinWho.email) && !profiles.sameAccount(saved, pinWho)) {
    return { ok: false, reason: 'different-account', who: pinWho }
  }

  const payload = profiles.readPayload(root, name)
  const profMeta = profiles.readMeta(root, name)
  let A
  let oauthAccount = payload.identity && payload.identity.oauthAccount
  if (active) {
    A = credstore.read(null, o)
    const id = profiles.currentIdentity(o)
    if (!profiles.sameAccount(saved, { accountUuid: id && id.accountUuid, email: id && id.email })) {
      return { ok: false, reason: 'conflict', detail: 'the live login is another account' }
    }
    oauthAccount = oauthAccount || { emailAddress: id.email, accountUuid: id.accountUuid, organizationName: id.org, organizationUuid: id.orgUuid }
  } else {
    A = payload.credentials
  }
  if (!rtOf(A)) return { ok: false, reason: 'no-main' }
  if (rtOf(A) === rtOf(B)) return { ok: false, reason: 'conflict', detail: 'both slots hold the same login' }

  const j = {
    v: 1, name, active, A, B, oauthAccount, startedAt: Date.now(), retire: !!o.retire,
    fallback: { accountUuid: saved.accountUuid, email: saved.email, org: profMeta.org, plan: profMeta.plan },
    aSignedIn: Number.isFinite(profMeta.signedInAt) ? profMeta.signedInAt : null,
    bSignedIn: Number.isFinite(pinMeta.signedInAt) ? pinMeta.signedInAt : null,
  }
  writeJournal(root, name, j)
  step(o, 'journal')
  const s = slots(root, name, o, active)

  const mainMoved = () => { let M = null; try { M = s.readMain() } catch { M = null } return rtOf(M) !== rtOf(A) }
  const renewedDuring = { ok: false, reason: 'conflict', detail: 'a chat renewed the main login during the exchange; tried again later' }
  if (mainMoved()) { dropJournal(root, name); return renewedDuring }
  s.writePin(A)
  step(o, 'pin-written')
  if (mainMoved()) {
    s.writePin(B)
    dropJournal(root, name)
    return renewedDuring
  }
  try {
    s.writeMain(B)
  } catch (e) {
    try { s.writePin(B) } catch (e2) {
      return { ok: false, reason: 'error', detail: e.message + '. Putting the pinning login back also failed: ' + e2.message }
    }
    dropJournal(root, name)
    return { ok: false, reason: 'error', detail: e.message }
  }
  step(o, 'main-written')

  await (o.sleep || sleep)(o.verifyDelayMs === undefined ? VERIFY_DELAY_MS : o.verifyDelayMs)
  let outcome
  try { outcome = settle(s, A, B) } catch (e) {
    return { ok: false, reason: 'error', detail: 'the exchange met a running chat and could not be settled yet: ' + e.message }
  }
  step(o, 'settled')
  const pin = afterExchange(root, name, j, o, active)
  dropJournal(root, name)

  const result = { main: { expiresAt: endOf(s.readMain()) }, pinning: { expiresAt: endOf(pin) } }
  if (outcome !== 'exchanged') return { ok: false, reason: 'conflict', ...result }
  return { ok: true, ...result }
}

async function exchange(root, name, opts) {
  const o = { ...(opts || {}) }
  checkName(name)
  return withLock(root, name, o, () => exchangeLocked(root, name, o))
}

async function holdForeign(root, name, foreign, opts) {
  checkName(name)
  return withLock(root, name, opts, () => {
    ensurePinningRoot(root)
    const m = readMeta(root, name) || { v: 1 }
    m.foreign = { expiresAt: foreign.expiresAt || null, oauthAccount: isObj(foreign.oauthAccount) ? foreign.oauthAccount : null, since: Date.now() }
    m.expiresAt = null
    writeMeta(root, name, m)
    return { ok: true }
  })
}

function foreignOf(root, name) {
  const m = readMeta(root, name)
  return m && isObj(m.foreign) ? m.foreign : null
}

async function takeOutForeign(root, name, toConfigDir, opts) {
  const o = opts || {}
  checkName(name)
  return withLock(root, name, o, () => {
    const f = foreignOf(root, name)
    if (!f) return { ok: false, reason: 'not-held' }
    const dir = dirFor(root, name)
    let creds = null
    try { creds = credstore.read(dir, o) } catch { creds = null }
    if (rtOf(creds) && f.expiresAt && endOf(creds) !== f.expiresAt) return { ok: false, reason: 'changed' }
    if (toConfigDir && rtOf(creds)) {
      writeVerified(toConfigDir, creds, o)
      fsx.writeJsonAtomic(path.join(toConfigDir, '.claude.json'), { oauthAccount: f.oauthAccount }, { mode: 0o600 })
    }
    credstore.remove(dir, o)
    fs.rmSync(metaFile(root, name), { force: true })
    try { fs.rmdirSync(dir) } catch {  }
    return { ok: true, moved: !!(toConfigDir && rtOf(creds)) }
  })
}

const MODES = ['main-keep-old-for-pinning', 'pinning', 'main-only']

function adoptAsMain(root, name, fromConfigDir, got, o) {
  const active = liveIsAccount(root, name, o)
  const p = { ...o, move: true, sameAccountOnly: true }
  delete p.now
  profiles.importFromDir(root, name, fromConfigDir, p)
  if (active) profiles.apply(root, name, o)
  try {
    const pm = profiles.readMeta(root, name)
    pm.signedInAt = o.now || Date.now()
    profiles.writeMeta(root, name, pm)
  } catch {  }
  return { active, expiresAt: endOf(got.creds) }
}

async function adoptNewLogin(root, name, fromConfigDir, opts) {
  const o = { ...(opts || {}) }
  checkName(name)
  if (!MODES.includes(o.mode)) throw new Error('Unknown mode for a new login: ' + o.mode)
  return withLock(root, name, o, async () => {
    const now = o.now || Date.now()
    const got = readSignIn(fromConfigDir, o)
    if (got.error) return got.error
    const want = expectedWho(root, name, o.expected)
    if (want && !profiles.sameAccount(want, got.who)) return { ok: false, reason: 'different-account', who: got.who }
    const pinInfo = () => { const i = info(root, name, now); return i && hasLogin(root, name, o) ? { expiresAt: i.expiresAt } : null }
    const heldInUse = () => !!foreignOf(root, name) && listInUse(root, name, o).length > 0
    const held = { ok: false, reason: 'held-in-use' }

    if (o.mode === 'pinning') {
      if (heldInUse()) return held
      const r = importLocked(root, name, fromConfigDir, o.expected, o)
      if (!r.ok) return r
      const mainEnd = profiles.exists(root, name) ? (profiles.readMeta(root, name).loginExpiresAt || null) : null
      return { ok: true, mode: o.mode, main: mainEnd ? { expiresAt: mainEnd } : null, pinning: { expiresAt: r.expiresAt }, kept: null, oldDaysLeft: null }
    }

    const asMain = (kept, keptEnd) => {
      try { adoptAsMain(root, name, fromConfigDir, got, o) } catch (e) {
        if (e && e.code === 'EACCOUNTMISMATCH') return { ok: false, reason: 'different-account', who: got.who }
        if (e && e.code === 'ENOIDENTITY') return { ok: false, reason: 'no-identity' }
        throw e
      }
      return { ok: true, mode: o.mode, main: { expiresAt: endOf(got.creds) }, pinning: pinInfo(), kept, oldDaysLeft: kept ? daysLeft(keptEnd, now) : null }
    }

    if (o.mode === 'main-only' || !profiles.exists(root, name)) return asMain(null, null)

    const active = liveIsAccount(root, name, o)
    const A = active ? credstore.read(null, o) : profiles.readPayload(root, name).credentials
    let P = null
    try { P = credstore.read(dirFor(root, name), o) } catch { P = null }
    const pm = readMeta(root, name)
    if (pm && (isObj(pm.foreign) || pm.retired)) P = null
    const aOk = valid(A, now)
    const pOk = valid(P, now)
    const keepA = aOk && !(pOk && (endOf(P) || Infinity) >= (endOf(A) || Infinity))
    if (!keepA) return asMain(pOk ? 'old-pinning' : null, pOk ? endOf(P) : null)

    if (heldInUse()) return held
    const r = importLocked(root, name, fromConfigDir, o.expected, o)
    if (!r.ok) return r
    const x = await exchangeLocked(root, name, { ...o, active: undefined })
    if (!x.ok) return { ...x, mode: o.mode }
    return { ok: true, mode: o.mode, main: x.main, pinning: x.pinning, kept: 'old-main', oldDaysLeft: daysLeft(endOf(A), now) }
  })
}

function listInUse(root, name, opts) {
  const alive = (opts && opts.pidAlive) || fsx.pidAlive
  const dir = inUseDir(root)
  let files = []
  try { files = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const f of files) {
    const m = /^(\d+)\.json$/.exec(f)
    if (!m) continue
    const file = path.join(dir, f)
    const j = fsx.readJsonLoose(file, null)
    const pid = j && Number.isInteger(j.pid) ? j.pid : Number(m[1])
    if (!alive(pid)) {
      try { fs.rmSync(file, { force: true }) } catch {  }
      continue
    }
    if (!isObj(j)) continue
    if (name !== undefined && name !== null && j.name !== name) continue
    out.push({ pid, sessionId: j.sessionId || null, cwd: j.cwd || null, startedAt: j.startedAt || null, name: j.name || null })
  }
  return out.sort((a, b) => a.pid - b.pid)
}

function loginCheckMs(platform) { return platform === 'darwin' ? 30000 : 5000 }

function decideExchange({ now, main, pinning, busy }) {
  const t = now || Date.now()
  const pEnd = pinning && pinning.expiresAt
  const mEnd = main && main.expiresAt
  if (!pEnd || !mEnd) return 'none'
  if (pEnd <= t + WRAPPER_MARGIN_MS) return 'none'
  if (mEnd - t >= LAST_DAY_MS) return 'none'
  if (pEnd <= mEnd) return 'none'
  return busy ? 'wait' : 'exchange'
}

function kindFor(expiresAt, now) {
  const left = expiresAt - now
  if (left <= 0) return 'expired'
  if (left < LAST_DAY_MS) return 'last-day'
  if (left < REMIND_3_DAYS_MS) return '3-days'
  return null
}

function loginKey(name, which, expiresAt) { return name + '|' + which + '|' + expiresAt }

function covers(pinning, mainEnd, now) {
  const pEnd = pinning && pinning.expiresAt
  return !!pEnd && pEnd > now + WRAPPER_MARGIN_MS && pEnd > mainEnd + WRAPPER_MARGIN_MS
}

function dueReminders({ now, accounts, state }) {
  const t = now || Date.now()
  const s = normalState(state)
  const out = []
  for (const a of accounts || []) {
    for (const which of ['main', 'pinning']) {
      const end = a && a[which] && a[which].expiresAt
      if (!end) continue
      const kind = kindFor(end, t)
      if (!kind) continue
      if (which === 'main' && kind !== 'expired' && covers(a.pinning, end, t)) continue
      const login = loginKey(a.name, which, end)
      const key = login + '|' + kind
      if (s.done[key]) continue
      if ((s.snoozed[login] || 0) > t) continue
      out.push({ name: a.name, which, kind, key })
    }
  }
  return out
}

function normalState(state) {
  const s = isObj(state) ? state : {}
  return { v: 1, done: isObj(s.done) ? { ...s.done } : {}, snoozed: isObj(s.snoozed) ? { ...s.snoozed } : {} }
}

function answerReminder(state, reminder, { now, notNow } = {}) {
  const t = now || Date.now()
  const s = normalState(state)
  const login = reminder.key.split('|').slice(0, 3).join('|')
  if (notNow) s.snoozed[login] = t + SNOOZE_MS
  else s.done[reminder.key] = t
  return pruneReminders(s, t)
}

function pruneReminders(state, now) {
  const s = normalState(state)
  const old = (k) => { const end = Number(k.split('|')[2]); return Number.isFinite(end) && end < now - 30 * DAY }
  for (const k of Object.keys(s.done)) if (old(k)) delete s.done[k]
  for (const k of Object.keys(s.snoozed)) if (old(k) || s.snoozed[k] <= now) delete s.snoozed[k]
  return s
}

function reminderFile(root) { return path.join(root, 'reminders.json') }
function readReminderState(root) { return normalState(fsx.readJsonLoose(reminderFile(root), null)) }
function writeReminderState(root, state) {
  fsx.writeFileAtomic(reminderFile(root), JSON.stringify(normalState(state), null, 2), { mode: 0o600, forceMode: true })
}

function hasPinning(root, name, o) {
  return !!readMeta(root, name) || hasLogin(root, name, o)
}

async function migrateWindowLogins(root, now, opts) {
  const o = { ...(opts || {}) }
  const t = now || Date.now()
  let entries = []
  try { entries = fs.readdirSync(windows.windowsRoot(root)) } catch { return [] }
  const out = []
  for (const name of entries.sort()) {
    if (!store.validName(name)) continue
    let isDir = false
    try { isDir = fs.statSync(path.join(windows.windowsRoot(root), name)).isDirectory() } catch {  }
    if (!isDir) continue
    if (o.skip && o.skip(name)) { out.push({ name, moved: false, removed: false, reason: 'skipped' }); continue }
    let r
    try { r = await withLock(root, name, o, () => migrateOne(root, name, t, o)) } catch (e) { r = { name, moved: false, removed: false, reason: 'error', error: (e && e.message) || String(e) } }
    out.push(r.reason === 'locked' && r.ok === false ? { name, moved: false, removed: false, reason: 'locked' } : r)
  }
  return out
}

function migrateOne(root, name, now, o) {
  const wdir = windows.windowDir(root, name)
  const state = windows.loginState(root, name, { ...o, now })
  if (state === 'unknown') return { name, moved: false, removed: false, reason: 'unknown' }
  let moved = false
  let reason = state === 'yes' ? null : state === 'no' ? 'no-login' : 'expired'
  if (state === 'yes') {
    if (hasPinning(root, name, o)) reason = 'has-pinning'
    else {
      const creds = credstore.read(wdir, o)
      const raw = identityIn(wdir)
      const id = windows.identity(root, name)
      const who = whoOf(raw)
      const want = expectedWho(root, name)
      if (!rtOf(creds)) reason = 'no-login'
      else if (want && (who.accountUuid || who.email) && !profiles.sameAccount(want, who)) reason = 'different-account'
      else {
        ensurePinningRoot(root)
        const dir = dirFor(root, name)
        fs.mkdirSync(dir, { recursive: true })
        writeVerified(dir, creds, o)
        credstore.remove(wdir, o)
        const saved = profiles.exists(root, name) ? profiles.readMeta(root, name) : {}
        writeMeta(root, name, metaFor(raw, creds, null, {
          accountUuid: saved.accountUuid, email: (id && id.email) || saved.email, orgName: (id && id.org) || saved.org, plan: saved.plan,
        }))
        moved = true
      }
    }
  }
  let removed = false
  try { removed = !!windows.remove(root, name, o) } catch (e) {
    return { name, moved, removed: false, reason: 'remove-failed', error: (e && e.message) || String(e) }
  }
  return reason ? { name, moved, removed, reason } : { name, moved, removed }
}

module.exports = {
  loginCheckMs, holdForeign, foreignOf, takeOutForeign,
  dirFor, metaFile, inUseDir, pinningRoot, names, readMeta, info, hasLogin, wrapperLogin,
  importPinning, remove, setPinningLogin, exchange, recover, adoptNewLogin, listInUse,
  decideExchange, dueReminders, answerReminder, readReminderState, writeReminderState, reminderFile,
  migrateWindowLogins,
  daysLeft, stateOf,
  MODES, DAY, SOON_MS, LAST_DAY_MS, VERIFY_DELAY_MS,
  _test: { whose, journalFile },
}
