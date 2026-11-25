const locks = require('./locks')
const { applyPreferences } = require('./preferences')
const profiles = require('./profiles')
const store = require('./store')
const tracker = require('./tracker')
const usage = require('./usage')

const ROUNDS = 3

function failure(code, message, cause) {
  const e = new Error(message)
  e.code = code
  if (cause) e.cause = cause
  return e
}

async function lockAccounts(root, names, opts) {
  const held = []
  for (const n of [...new Set(names.filter(Boolean))].sort()) {
    const release = await locks.acquire(root, tracker.accountLock(n),
      { waitMs: (opts && opts.waitMs) || 45000, staleMs: tracker.LOCK_STALE_MS })
    if (!release) {
      held.forEach((r) => r())
      return null
    }
    held.push(release)
  }
  return held
}

function cacheMixed(root, active) {
  try { return require('./logins').listInUse(root).some((u) => u.name && u.name !== active) } catch { return false }
}

async function switchAccount(root, name, opts) {
  const o = opts || {}
  const paths = o.home ? { home: o.home } : undefined
  const lock = o.lock || ((names) => lockAccounts(root, names))
  if (!profiles.exists(root, name)) throw failure('NOTSAVED', 'There is no saved account "' + name + '".')
  let active = profiles.activeProfile(root, paths)
  if (active === name) return { switched: false, from: active, to: name }
  if (!active && !o.withoutSaving && profiles.hasCurrentLogin(paths)) {
    throw failure('UNSAVED', 'The account Claude Code is using now isn\'t saved in the switcher, and switching would replace its login.')
  }
  let held = null
  for (let round = 0; round < ROUNDS; round++) {
    held = await lock([name, active])
    if (!held) throw failure('BUSY', 'A background login renewal did not finish. Try again in a minute.')
    const now = profiles.activeProfile(root, paths)
    if (now === active) break
    held.forEach((r) => r())
    held = null
    active = now
    if (active === name) return { switched: false, from: active, to: name }
  }
  if (!held) throw failure('MOVING', 'The live account kept changing in another window. Try again.')
  let applied
  try {
    if (active && profiles.hasCurrentLogin(paths)) {
      try { profiles.capture(root, active, paths) } catch (e) {
        const err = failure('CAPTURE', 'The login Claude Code is using now couldn\'t be saved to "' + active + '" first. ' +
          (e && e.message) + ' Nothing was changed.', e)
        err.account = active
        throw err
      }
    }
    usage.rememberClaudeCache(root, o.home || null, { skipClaude: o.skipClaudeCache === undefined ? cacheMixed(root, active) : !!o.skipClaudeCache })
    applied = profiles.apply(root, name, paths)
  } finally {
    held.forEach((r) => r())
  }
  applyPreferences(root, name, Object.assign({}, paths, { log: o.log }))
  const by = store.LIVE_BY.includes(o.by) ? o.by : 'hub'
  if (typeof o.log === 'function') { try { o.log('switch to "' + name + '": ' + by) } catch {  } }
  try { store.recordLive(root, name, undefined, by) } catch {  }
  return { switched: true, from: active, to: name, email: (applied && applied.email) || null }
}

module.exports = { switchAccount, lockAccounts }
