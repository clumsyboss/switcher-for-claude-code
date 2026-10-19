const fs = require('fs')
const os = require('os')
const path = require('path')

const secrets = require('./secrets')
const credstore = require('./credstore')
const fsx = require('./fsx')

const CRED_FILE = '.credentials.json'

const STALE_AFTER_SWITCH = [
  'cachedUsageUtilization',
  'cachedArtifactRoster',
  'githubWebConnectionStatusCache',
  'cachedExtraUsageDisabledReason',
]

const IDENTITY_KEYS = ['oauthAccount', 'userID']

const BACKUPS_KEPT = 5

class AccountMismatchError extends Error {
  constructor(message) {
    super(message)
    this.code = 'EACCOUNTMISMATCH'
  }
}

class NoIdentityError extends Error {
  constructor(message) {
    super(message)
    this.code = 'ENOIDENTITY'
  }
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const validName = (n) => typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(n)

function paths(opts) {
  const home = (opts && opts.home) || os.homedir()
  return {
    claudeDir: path.join(home, '.claude'),
    credPath: path.join(home, '.claude', CRED_FILE),
    claudeJson: path.join(home, '.claude.json'),
  }
}

function checkName(name) {
  if (!validName(name)) throw new Error('Invalid account name: ' + name)
  return name
}

function profilesDir(root) { return path.join(root, 'profiles') }
function blobPath(root, name) { return path.join(profilesDir(root), checkName(name) + '.enc') }
function metaPath(root, name) { return path.join(profilesDir(root), checkName(name) + '.meta.json') }

function writeAtomic(file, data) {
  fsx.writeFileAtomic(file, data, { mode: 0o600, forceMode: true })
}

function readJson(file, fallback) { return fsx.readJsonLoose(file, fallback) }

function whoIn(identity) {
  const o = identity && isObj(identity.oauthAccount) ? identity.oauthAccount : null
  return {
    accountUuid: o && typeof o.accountUuid === 'string' && o.accountUuid ? o.accountUuid : null,
    email: o && typeof o.emailAddress === 'string' && o.emailAddress ? o.emailAddress : null,
  }
}

function sameAccount(a, b) {
  if (!a || !b) return false
  if (a.accountUuid && b.accountUuid) return a.accountUuid === b.accountUuid
  return !!a.email && !!b.email && a.email.toLowerCase() === b.email.toLowerCase()
}

function pickIdentity(cfg) {
  const identity = {}
  for (const k of IDENTITY_KEYS) if (cfg && cfg[k] !== undefined) identity[k] = cfg[k]
  return identity
}

function hasCurrentLogin(opts) {
  return credstore.exists(null, opts)
}

function currentIdentity(opts) {
  const j = readJson(paths(opts).claudeJson, null)
  const o = j && isObj(j.oauthAccount) ? j.oauthAccount : null
  if (!o) return null
  return { email: o.emailAddress || null, org: o.organizationName || null, accountUuid: o.accountUuid || null }
}

function liveSnapshot(opts) {
  const credentials = credstore.read(null, opts)
  const identity = pickIdentity(readJson(paths(opts).claudeJson, {}) || {})
  const who = whoIn(identity)
  const o = credentials && credentials.claudeAiOauth
  return { credentials, identity, ...who, refreshToken: (o && o.refreshToken) || null }
}

function savedWho(root, name) {
  const meta = readMeta(root, name)
  let accountUuid = typeof meta.accountUuid === 'string' && meta.accountUuid ? meta.accountUuid : null
  let email = typeof meta.email === 'string' && meta.email ? meta.email : null
  if (!accountUuid && exists(root, name)) {
    try {
      const who = whoIn(readPayload(root, name).identity)
      if (who.accountUuid) {
        accountUuid = who.accountUuid
        writeMeta(root, name, { ...meta, accountUuid })
      }
      email = email || who.email
    } catch {  }
  }
  return { accountUuid, email }
}

function backupProfile(root, name) {
  const blob = blobPath(root, name)
  if (!fs.existsSync(blob)) return null
  const dir = path.join(root, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const stampStr = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(dir, name + '-' + stampStr + '.enc')
  fs.copyFileSync(blob, dest)
  try { fs.chmodSync(dest, 0o600) } catch {  }
  try {
    const mine = fs.readdirSync(dir).filter((f) => f.endsWith('.enc') &&
      f.slice(0, f.length - stampStr.length - 5) === name).sort()
    for (const old of mine.slice(0, Math.max(0, mine.length - BACKUPS_KEPT))) fs.rmSync(path.join(dir, old), { force: true })
  } catch {  }
  return dest
}

function capture(root, name, opts) {
  checkName(name)
  const snap = liveSnapshot(opts)
  if (!snap.credentials || !isObj(snap.credentials.claudeAiOauth)) {
    throw new Error('No active login found in ' + credstore.describe(null, opts))
  }
  if (!snap.accountUuid && !snap.email) {
    throw new NoIdentityError("Claude Code's login has no account details in ~/.claude.json yet, so it can't be " +
      'told apart from your other accounts. Use Claude Code once (any message), then try again.')
  }
  if (exists(root, name)) {
    const saved = savedWho(root, name)
    if ((saved.accountUuid || saved.email) && !sameAccount(saved, snap)) {
      throw new AccountMismatchError('The login Claude Code is using now is ' + (snap.email || 'another account') +
        ', not "' + name + '"' + (saved.email ? ' (' + saved.email + ')' : '') + ', so it was not saved over it.')
    }
  }
  if (!exists(root, name)) {
    const twin = findSameAccount(root, snap, name)
    if (twin) {
      throw new AccountMismatchError('The login Claude Code is using now is already saved as "' + twin +
        '", so it was not saved as "' + name + '" too. Two saved copies of one login sign each other out.')
    }
  }
  if (snap.refreshToken) {
    for (const other of list(root)) {
      if (other.name === name) continue
      if (sameAccount({ accountUuid: other.accountUuid || null, email: other.email || null }, snap)) continue
      let rt = null
      try { const c = readPayload(root, other.name).credentials; rt = c && c.claudeAiOauth && c.claudeAiOauth.refreshToken } catch { continue }
      if (rt && rt === snap.refreshToken) {
        throw new AccountMismatchError('The login Claude Code is using now is already saved as "' + other.name +
          '", so it was not saved as "' + name + '" too. Two saved accounts sharing one login sign each other out.')
      }
    }
  }
  backupProfile(root, name)
  return writeProfile(root, name, snap.credentials, snap.identity)
}

function writeProfile(root, name, credentials, identity, fallback) {
  const payload = { credentials, identity, capturedAt: new Date().toISOString() }
  fs.mkdirSync(profilesDir(root), { recursive: true })
  writeAtomic(blobPath(root, name), secrets.protect(Buffer.from(JSON.stringify(payload), 'utf8')))

  const o = identity.oauthAccount || {}
  const email = o.emailAddress || (fallback && fallback.email) || null
  const org = o.organizationName || (fallback && fallback.org) || null
  writeAtomic(metaPath(root, name), JSON.stringify({
    email, org, subscription: o.seatTier || null, capturedAt: payload.capturedAt,
    accountUuid: o.accountUuid || null,
  }, null, 2))
  return { email, org }
}

function readPayload(root, name) {
  return JSON.parse(secrets.unprotect(fs.readFileSync(blobPath(root, name))).toString('utf8'))
}

function readMeta(root, name) {
  const m = readJson(metaPath(root, name), {})
  return isObj(m) ? m : {}
}

function writeMeta(root, name, meta) {
  writeAtomic(metaPath(root, name), JSON.stringify(meta, null, 2))
}

function updateCredentials(root, name, credentials, opts) {
  const payload = readPayload(root, name)
  const savedRt = payload.credentials && payload.credentials.claudeAiOauth && payload.credentials.claudeAiOauth.refreshToken
  if (opts && opts.ifRefreshToken !== undefined && savedRt !== opts.ifRefreshToken) return false
  payload.credentials = credentials
  payload.renewedAt = new Date().toISOString()
  writeAtomic(blobPath(root, name), secrets.protect(Buffer.from(JSON.stringify(payload), 'utf8')))

  const back = readPayload(root, name)
  const want = credentials.claudeAiOauth && credentials.claudeAiOauth.refreshToken
  const got = back.credentials && back.credentials.claudeAiOauth && back.credentials.claudeAiOauth.refreshToken
  if (!want || got !== want) throw new Error('Renewed login for "' + name + '" did not read back correctly')

  const meta = readMeta(root, name)
  meta.renewedAt = payload.renewedAt
  delete meta.needsLogin
  delete meta.needsLoginReason
  writeMeta(root, name, meta)
  return true
}

function markNeedsLogin(root, name, reason) {
  const meta = readMeta(root, name)
  meta.needsLogin = true
  meta.needsLoginReason = reason || 'the saved login was rejected'
  meta.needsLoginAt = new Date().toISOString()
  writeMeta(root, name, meta)
}

function importFromDir(root, name, dir, opts) {
  checkName(name)
  const credentials = credstore.read(dir, opts)
  if (!credentials || !credentials.claudeAiOauth) {
    throw new Error('No login found in ' + credstore.describe(dir, opts))
  }
  const identity = pickIdentity(readJson(path.join(dir, '.claude.json'), {}) || {})
  const confirmed = opts && opts.confirmedEmail
  if (!isObj(identity.oauthAccount) && typeof confirmed === 'string' && confirmed) {
    identity.oauthAccount = { emailAddress: confirmed, ...(opts.fallback && opts.fallback.org ? { organizationName: opts.fallback.org } : {}) }
  }
  const who = whoIn(identity)
  if (!who.accountUuid && !who.email) {
    throw new NoIdentityError('The sign-in finished, but Claude Code has not written its account details yet. ' +
      'It will be added as soon as it has.')
  }
  if (opts && opts.sameAccountOnly && exists(root, name)) {
    const saved = savedWho(root, name)
    if ((saved.accountUuid || saved.email) && !sameAccount(saved, who)) {
      throw new AccountMismatchError('That signed in as ' + (who.email || 'another account') + ', not "' + name + '"' +
        (saved.email ? ' (' + saved.email + ')' : '') + ', so it was not saved over it.')
    }
  }

  backupProfile(root, name)
  const result = writeProfile(root, name, credentials, identity, opts && opts.fallback)

  if (opts && opts.move) {
    const back = readPayload(root, name)
    const same = back.credentials && back.credentials.claudeAiOauth &&
      back.credentials.claudeAiOauth.refreshToken === credentials.claudeAiOauth.refreshToken
    if (!same) throw new Error('Encrypted copy did not verify; source login left in place')
    credstore.remove(dir, opts)
  }
  return result
}

function findSameAccount(root, who, except) {
  if (!who || (!who.accountUuid && !who.email)) return null
  const hits = list(root).filter((p) => p.name !== except &&
    sameAccount({ accountUuid: p.accountUuid || null, email: p.email || null }, who))
  return hits.length ? hits[0].name : null
}

function findByEmail(root, email, except) {
  return findSameAccount(root, { email }, except)
}

function capturedAt(root, name) {
  const m = readMeta(root, name)
  const t = Date.parse(m.capturedAt)
  return Number.isNaN(t) ? 0 : t || 0
}

function apply(root, name, opts) {
  const p = paths(opts)
  const payload = readPayload(root, name)
  const identity = isObj(payload.identity) ? payload.identity : {}
  if (!isObj(identity.oauthAccount)) {
    throw new NoIdentityError('"' + name + '" was saved without its account details, so switching to it could ' +
      'mix two accounts up. Sign it in again.')
  }

  fs.mkdirSync(p.claudeDir, { recursive: true })
  let { data: cfg, stamp } = fsx.readJsonForWrite(p.claudeJson)
  const previous = credstore.read(null, opts)

  credstore.write(null, payload.credentials, opts)
  try {
    for (let attempt = 0; ; attempt++) {
      for (const k of IDENTITY_KEYS) {
        if (identity[k] !== undefined) cfg[k] = identity[k]
        else delete cfg[k]
      }
      for (const k of STALE_AFTER_SWITCH) delete cfg[k]
      try {
        fsx.writeFileAtomic(p.claudeJson, JSON.stringify(cfg, null, 2), { expect: stamp })
        break
      } catch (e) {
        if (e.code !== 'ECONCURRENTWRITE' || attempt >= 4) throw e
        ;({ data: cfg, stamp } = fsx.readJsonForWrite(p.claudeJson))
      }
    }
  } catch (e) {
    try {
      if (previous) credstore.write(null, previous, opts)
      else credstore.remove(null, opts)
    } catch (e2) {
      e.message += '. The previous login could not be put back either (' + e2.message + ')'
    }
    throw e
  }

  const o = identity.oauthAccount
  return { email: o.emailAddress || null, org: o.organizationName || null }
}

function list(root) {
  let files = []
  try { files = fs.readdirSync(profilesDir(root)) } catch { return [] }
  return files
    .filter((f) => f.endsWith('.enc'))
    .map((f) => f.slice(0, -4))
    .filter(validName)
    .sort()
    .map((name) => ({ ...readMeta(root, name), name }))
}

function exists(root, name) { return validName(name) && fs.existsSync(blobPath(root, name)) }

function remove(root, name) {
  for (const f of [blobPath(root, name), metaPath(root, name)]) {
    try { fs.rmSync(f, { force: true }) } catch {  }
  }
}

function activeProfile(root, opts) {
  const id = currentIdentity(opts)
  if (!id) return null
  const live = { accountUuid: id.accountUuid, email: id.email }
  const metas = list(root)
  if (live.accountUuid) {
    const byUuid = metas.filter((m) => m.accountUuid === live.accountUuid)
    if (byUuid.length) return newest(byUuid).name
  }
  const byEmail = metas.filter((m) => !(m.accountUuid && live.accountUuid) &&
    sameAccount({ accountUuid: null, email: m.email || null }, { accountUuid: null, email: live.email }))
  const orgs = new Set(byEmail.map((m) => m.org || ''))
  if (byEmail.length && orgs.size === 1) return newest(byEmail).name
  return byEmail.length === 1 ? byEmail[0].name : null
}

function newest(metas) {
  const at = (m) => Math.max(Date.parse(m.renewedAt) || 0, Date.parse(m.capturedAt) || 0)
  return metas.slice().sort((a, b) => at(b) - at(a) || a.name.localeCompare(b.name))[0]
}

function duplicates(root) {
  const groups = []
  const seen = new Set()
  const metas = list(root)
  for (const m of metas) {
    if (seen.has(m.name)) continue
    const who = { accountUuid: m.accountUuid || null, email: m.email || null }
    if (!who.accountUuid && !who.email) continue
    const same = metas.filter((x) => (x.name === m.name || sameAccount({ accountUuid: x.accountUuid || null, email: x.email || null }, who)) &&
      (who.accountUuid || x.accountUuid || (x.org || '') === (m.org || '')))
    same.forEach((x) => seen.add(x.name))
    if (same.length > 1) groups.push(same.map((x) => x.name))
  }
  return groups
}

module.exports = {
  readPayload, readMeta, writeMeta, updateCredentials, markNeedsLogin,
  capture, apply, list, exists, remove, activeProfile,
  importFromDir, findByEmail, findSameAccount, sameAccount, duplicates, newest, liveSnapshot, savedWho, capturedAt, backupProfile,
  hasCurrentLogin, currentIdentity, paths, profilesDir,
  AccountMismatchError, NoIdentityError,
  STALE_AFTER_SWITCH, IDENTITY_KEYS,
}
