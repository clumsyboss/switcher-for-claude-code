const fs = require('fs')
const path = require('path')

const fsx = require('./fsx')
const locks = require('./locks')
const moveLib = require('./movefile')
const profiles = require('./profiles')
const secrets = require('./secrets')
const store = require('./store')

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

function fail(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

function wasImported(file) { return /\.imported-[^/\\]*$/.test(String(file)) }

async function exportAccounts(root, names, passphrase, file, opts) {
  const o = opts || {}
  if (!names || !names.length) throw fail('ENONAME', 'Name the accounts to move.')
  if (typeof passphrase !== 'string' || passphrase.length < moveLib.MIN_PASSPHRASE) {
    throw fail('EPASSPHRASE', 'Use a passphrase of at least ' + moveLib.MIN_PASSPHRASE + ' characters.')
  }
  if (!fs.existsSync(path.dirname(file))) throw fail('ENOFOLDER', 'The folder ' + path.dirname(file) + " doesn't exist. Pick one that does.")
  if (!o.overwrite && fs.existsSync(file)) throw fail('EEXIST', file + ' already exists. Pick another name, or delete it first.')
  const live = () => profiles.activeProfile(root, o)
  for (const n of names) {
    if (!profiles.exists(root, n)) throw fail('ENOACCOUNT', 'No saved account called "' + n + '" on this PC.')
    if (n === live()) throw fail('ELIVE', '"' + n + '" is the account Claude Code is using on this PC. Switch to another one first.')
  }

  const held = []
  try {
    for (const n of names) {
      const release = await locks.acquire(root, 'account-' + n, { waitMs: o.waitMs === undefined ? 60000 : o.waitMs })
      if (!release) throw fail('EBUSY', '"' + n + '" is busy renewing. Try again in a minute.')
      held.push(release)
    }
    const now = live()
    if (names.includes(now)) throw fail('ELIVE', '"' + now + '" became the account Claude Code is using here. Nothing was moved.')

    const accounts = names.map((n) => ({
      name: n,
      payload: profiles.readPayload(root, n),
      meta: profiles.readMeta(root, n),
      display: store.displayOf(root, n),
      remote: store.getRemote(root, n),
      artifacts: store.getArtifacts(root, n),
    }))
    const sealed = moveLib.seal({ exportedAt: new Date().toISOString(), accounts }, passphrase)
    fsx.writeFileAtomic(file, sealed, { mode: 0o600, forceMode: true, fsync: true })
    const check = moveLib.open(fs.readFileSync(file, 'utf8'), passphrase)
    if (check.accounts.length !== names.length ||
      check.accounts.some((a, i) => JSON.stringify(a.payload) !== JSON.stringify(accounts[i].payload))) {
      throw fail('EVERIFY', 'The file did not read back correctly; nothing was removed.')
    }
    const backups = []
    for (const n of names) {
      const b = profiles.backupProfile(root, n)
      if (b) backups.push(b)
      profiles.remove(root, n)
    }
    return { moved: names.slice(), file, backups }
  } finally {
    held.forEach((r) => r())
  }
}

function readFile(file, passphrase) {
  if (wasImported(file)) {
    throw fail('EUSED', path.basename(file) + ' was already imported once. Importing a login twice would have two ' +
      'saved copies sign each other out; make a new file instead.')
  }
  const bundle = moveLib.open(fs.readFileSync(file, 'utf8'), passphrase)
  const accounts = []
  const invalid = []
  for (const raw of bundle.accounts) {
    const v = moveLib.validateAccount(raw, store)
    const name = raw && typeof raw.name === 'string' ? raw.name.slice(0, 40) : '(unnamed)'
    if (v.ok) accounts.push(v.account)
    else invalid.push({ name, reason: v.reason })
  }
  return {
    exportedAt: typeof bundle.exportedAt === 'string' ? bundle.exportedAt : null,
    kind: typeof bundle.kind === 'string' ? bundle.kind : null,
    accounts, invalid,
  }
}

function planFor(root, a, exportedAt, opts) {
  const who = { accountUuid: a.meta.accountUuid, email: a.meta.email }
  if (!profiles.exists(root, a.name)) {
    const twin = profiles.findSameAccount(root, who, a.name)
    if (twin) return { action: 'skip', reason: 'this account is already saved here as "' + twin + '"' }
    return { action: 'add' }
  }
  if (profiles.activeProfile(root, opts) === a.name) {
    return { action: 'skip', reason: 'Claude Code is using it here; switch to another account first' }
  }
  const saved = profiles.savedWho(root, a.name)
  if ((saved.accountUuid || saved.email) && !profiles.sameAccount(saved, who)) {
    return { action: 'skip', reason: 'a different account is saved here under that name (' + (saved.email || saved.accountUuid) + ')' }
  }
  const m = profiles.readMeta(root, a.name)
  const savedAt = Date.parse(m.renewedAt || m.capturedAt)
  const fileAt = Date.parse(exportedAt)
  if (!m.needsLogin && savedAt && fileAt && savedAt > fileAt) {
    return { action: 'skip', reason: 'the login saved here is newer than the one in the file' }
  }
  return { action: 'replace' }
}

function save(root, a, replace, exportedAt, opts) {
  const plan = planFor(root, a, exportedAt, opts)
  if (plan.action === 'skip') return plan.reason
  if (plan.action === 'replace' && !replace) return 'already saved here, and left as it is'

  const existed = plan.action === 'replace'
  const blob = path.join(profiles.profilesDir(root), a.name + '.enc')
  const backup = existed ? profiles.backupProfile(root, a.name) : null
  fs.mkdirSync(profiles.profilesDir(root), { recursive: true })
  fsx.writeFileAtomic(blob, secrets.protect(Buffer.from(JSON.stringify(a.payload), 'utf8')), { mode: 0o600, forceMode: true })
  if (JSON.stringify(profiles.readPayload(root, a.name)) !== JSON.stringify(a.payload)) {
    if (backup) fs.copyFileSync(backup, blob)
    else profiles.remove(root, a.name)
    return 'it could not be saved securely here'
  }
  profiles.writeMeta(root, a.name, a.meta)
  if (Object.keys(a.display).length) store.setDisplay(root, a.name, a.display)
  if (a.remote === 'off') store.setRemote(root, a.name, 'off')
  if (a.artifacts === 'off') store.setArtifacts(root, a.name, 'off')
  return null
}

async function importAccounts(root, read, opts) {
  const o = opts || {}
  const replace = o.replace instanceof Set ? o.replace : new Set(o.replace || [])
  store.ensureRoot(root)
  const out = { added: [], replaced: [], skipped: read.invalid.slice() }
  for (const a of read.accounts) {
    const release = await locks.acquire(root, 'account-' + a.name, { waitMs: o.waitMs === undefined ? 60000 : o.waitMs })
    if (!release) { out.skipped.push({ name: a.name, reason: 'busy renewing; try again in a minute' }); continue }
    try {
      const existed = profiles.exists(root, a.name)
      const why = save(root, a, replace.has(a.name), read.exportedAt, o)
      if (why) out.skipped.push({ name: a.name, reason: why })
      else (existed ? out.replaced : out.added).push(a.name)
    } finally {
      release()
    }
  }
  return out
}

function markImported(file) {
  const used = file + '.imported-' + stamp()
  try { fs.renameSync(file, used); return used } catch { return null }
}

module.exports = { wasImported, exportAccounts, readFile, planFor, importAccounts, markImported }
