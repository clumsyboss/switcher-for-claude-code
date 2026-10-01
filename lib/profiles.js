const fs = require('fs')
const os = require('os')
const path = require('path')

const secrets = require('./secrets')
const credstore = require('./credstore')

const CRED_FILE = '.credentials.json'

const STALE_AFTER_SWITCH = [
  'cachedUsageUtilization',
  'cachedArtifactRoster',
  'githubWebConnectionStatusCache',
  'cachedExtraUsageDisabledReason',
]

const IDENTITY_KEYS = ['oauthAccount', 'userID']

function paths(opts) {
  const home = (opts && opts.home) || os.homedir()
  return {
    claudeDir: path.join(home, '.claude'),
    credPath: path.join(home, '.claude', CRED_FILE),
    claudeJson: path.join(home, '.claude.json'),
  }
}

function profilesDir(root) { return path.join(root, 'profiles') }
function blobPath(root, name) { return path.join(profilesDir(root), name + '.enc') }
function metaPath(root, name) { return path.join(profilesDir(root), name + '.meta.json') }

function writeAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function hasCurrentLogin(opts) {
  return credstore.exists(null, opts)
}

function currentIdentity(opts) {
  const j = readJson(paths(opts).claudeJson, null)
  const o = j && j.oauthAccount
  if (!o) return null
  return { email: o.emailAddress || null, org: o.organizationName || null }
}

function capture(root, name, opts) {
  const p = paths(opts)
  const credentials = credstore.read(null, opts)
  if (!credentials) throw new Error('No active login found in ' + credstore.describe(null, opts))

  return writeProfile(root, name, credentials, pickIdentity(readJson(p.claudeJson, {})))
}

function pickIdentity(cfg) {
  const identity = {}
  for (const k of IDENTITY_KEYS) if (cfg && cfg[k] !== undefined) identity[k] = cfg[k]
  return identity
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

function readMeta(root, name) { return readJson(metaPath(root, name), {}) || {} }

function writeMeta(root, name, meta) {
  writeAtomic(metaPath(root, name), JSON.stringify(meta, null, 2))
}

function updateCredentials(root, name, credentials) {
  const payload = readPayload(root, name)
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
}

function markNeedsLogin(root, name, reason) {
  const meta = readMeta(root, name)
  meta.needsLogin = true
  meta.needsLoginReason = reason || 'the saved login was rejected'
  meta.needsLoginAt = new Date().toISOString()
  writeMeta(root, name, meta)
}

function importFromDir(root, name, dir, opts) {
  const credentials = credstore.read(dir, opts)
  if (!credentials || !credentials.claudeAiOauth) {
    throw new Error('No login found in ' + credstore.describe(dir, opts))
  }

  const result = writeProfile(root, name, credentials,
    pickIdentity(readJson(path.join(dir, '.claude.json'), {})), opts && opts.fallback)

  if (opts && opts.move) {
    const back = JSON.parse(secrets.unprotect(fs.readFileSync(blobPath(root, name))).toString('utf8'))
    const same = back.credentials && back.credentials.claudeAiOauth &&
      back.credentials.claudeAiOauth.refreshToken === credentials.claudeAiOauth.refreshToken
    if (!same) throw new Error('Encrypted copy did not verify; source login left in place')
    credstore.remove(dir, opts)
  }
  return result
}

function findByEmail(root, email, except) {
  if (!email) return null
  const hit = list(root).find((p) => p.email === email && p.name !== except)
  return hit ? hit.name : null
}

function capturedAt(root, name) {
  const m = readJson(metaPath(root, name), null)
  const t = m && Date.parse(m.capturedAt)
  return Number.isNaN(t) ? 0 : t || 0
}

function apply(root, name, opts) {
  const p = paths(opts)
  const blob = fs.readFileSync(blobPath(root, name))
  const payload = JSON.parse(secrets.unprotect(blob).toString('utf8'))

  fs.mkdirSync(p.claudeDir, { recursive: true })
  credstore.write(null, payload.credentials, opts)

  const cfg = readJson(p.claudeJson, {}) || {}
  for (const k of IDENTITY_KEYS) {
    if (payload.identity && payload.identity[k] !== undefined) cfg[k] = payload.identity[k]
  }
  for (const k of STALE_AFTER_SWITCH) delete cfg[k]
  writeAtomic(p.claudeJson, JSON.stringify(cfg, null, 2))

  const o = (payload.identity && payload.identity.oauthAccount) || {}
  return { email: o.emailAddress || null, org: o.organizationName || null }
}

function list(root) {
  let files = []
  try { files = fs.readdirSync(profilesDir(root)) } catch { return [] }
  return files
    .filter((f) => f.endsWith('.enc'))
    .map((f) => f.slice(0, -4))
    .sort()
    .map((name) => ({ name, ...(readJson(metaPath(root, name), {}) || {}) }))
}

function exists(root, name) { return fs.existsSync(blobPath(root, name)) }

function remove(root, name) {
  for (const f of [blobPath(root, name), metaPath(root, name)]) {
    try { fs.rmSync(f, { force: true }) } catch {  }
  }
}

function activeProfile(root, opts) {
  const cfg = readJson(paths(opts).claudeJson, null)
  const o = cfg && cfg.oauthAccount
  if (!o) return null
  for (const meta of list(root)) {
    if (meta.email && o.emailAddress && meta.email === o.emailAddress) return meta.name
  }
  return null
}

module.exports = {
  readPayload, readMeta, writeMeta, updateCredentials, markNeedsLogin,
  capture, apply, list, exists, remove, activeProfile,
  importFromDir, findByEmail, capturedAt,
  hasCurrentLogin, currentIdentity, paths, profilesDir,
  STALE_AFTER_SWITCH, IDENTITY_KEYS,
}
