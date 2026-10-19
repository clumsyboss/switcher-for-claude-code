const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const profiles = require('./profiles')
const credstore = require('./credstore')
const locks = require('./locks')
const claude = require('./claude')
const store = require('./store')
const fsx = require('./fsx')

const LOCK_STALE_MS = 2 * 60 * 1000
const RUN_TIMEOUT_MS = 75 * 1000
const KILL_GRACE_MS = 5 * 1000
const RENEW_FIRST_MS = 15 * 60 * 1000
const MAX_AGE_MS = 5 * 60 * 1000
const OWNER = 'owner.json'

const ARGS = ['-p', 'hi', '--model', 'haiku', '--no-session-persistence', '--tools', '',
  '--system-prompt', 'Reply with one word.', '--strict-mcp-config']

const STRIP_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR']

function kickoffRoot(root) { return path.join(root, 'kickoff') }

function envFor(dir) {
  const env = claude.envFor(dir)
  for (const k of STRIP_ENV) delete env[k]
  return env
}

function runCli(dir) {
  return new Promise((resolve) => {
    const bin = claude.resolveBin()
    if (!bin) { resolve({ ok: false, reason: "Claude Code's command-line tool (claude) wasn't found" }); return }
    let timedOut = false
    let killer = null
    const child = cp.execFile(bin, ARGS, { cwd: dir, env: envFor(dir), windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, _stdout, stderr) => {
        clearTimeout(timer)
        clearTimeout(killer)
        if (!err) { resolve({ ok: true }); return }
        const last = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).pop()
        resolve({ ok: false, reason: (timedOut ? 'it took too long' : (last || 'claude exited with ' + err.code)).slice(0, 200) })
      })
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {  }
      killer = setTimeout(() => { try { child.kill('SIGKILL') } catch {  } }, KILL_GRACE_MS)
    }, RUN_TIMEOUT_MS)
  })
}

function destroy(dir) {
  try { credstore.remove(dir) } catch { return false }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {  }
  return !fs.existsSync(dir)
}

function recover(root, dir, name) {
  if (!name || !profiles.exists(root, name)) return 'none'
  let creds
  try { creds = credstore.read(dir) } catch { return 'unreadable' }
  const got = creds && creds.claudeAiOauth
  if (!got || !got.refreshToken) return 'none'
  const release = locks.tryAcquire(root, 'account-' + name, LOCK_STALE_MS)
  if (!release) return 'unreadable'
  try {
    const payload = profiles.readPayload(root, name)
    const saved = (payload.credentials && payload.credentials.claudeAiOauth) || {}
    if (got.refreshToken === saved.refreshToken) return 'none'
    if ((got.expiresAt || 0) < (saved.expiresAt || 0)) return 'none'
    profiles.updateCredentials(root, name, { ...payload.credentials, claudeAiOauth: got }, { ifRefreshToken: saved.refreshToken })
    return 'saved'
  } catch { return 'unreadable' } finally { release() }
}

function cleanup(root) {
  let entries = []
  try { entries = fs.readdirSync(kickoffRoot(root)) } catch { return 0 }
  let removed = 0
  for (const e of entries) {
    const dir = path.join(kickoffRoot(root), e)
    const owner = fsx.readJsonLoose(path.join(dir, OWNER), null)
    let born = 0
    try { born = (owner && Number(owner.startedAt)) || fs.statSync(dir).mtimeMs } catch { continue }
    const running = owner && Number.isInteger(owner.pid) && fsx.pidAlive(owner.pid) && Date.now() - born < MAX_AGE_MS
    if (running) continue
    const legacy = !owner && /^(.+)-[A-Za-z0-9]{6}$/.exec(e)
    const name = owner && store.validName(owner.name) ? owner.name
      : legacy && store.validName(legacy[1]) ? legacy[1] : null
    if (recover(root, dir, name) === 'unreadable') continue
    if (destroy(dir)) removed++
  }
  return removed
}

async function startSession(root, name, deps) {
  const d = deps || {}
  const run = d.run || runCli
  if (profiles.readMeta(root, name).needsLogin) {
    return { ok: false, reason: 'its saved login has expired, so sign it in again first' }
  }

  const first = profiles.readPayload(root, name).credentials.claudeAiOauth || {}
  if (d.renew && first.expiresAt && first.expiresAt - Date.now() < RENEW_FIRST_MS) {
    const r = await d.renew(root, name, { force: true })
    if (r && r.failed === 'rejected') return { ok: false, reason: 'its saved login has expired, so sign it in again first' }
  }

  const release = await locks.acquire(root, 'account-' + name, { staleMs: LOCK_STALE_MS, waitMs: 30000 })
  if (!release) return { ok: false, reason: 'its login is being renewed right now, so try again in a minute' }
  let dir = null
  let keep = false
  try {
    const tracker = require('./tracker')
    const payload = profiles.readPayload(root, name)
    const saved = payload.credentials.claudeAiOauth
    if (tracker.isLive(profiles.readMeta(root, name), saved, tracker.liveState())) {
      return { ok: false, reason: "it's the account Claude Code is using now, so its session starts with your next message" }
    }

    fs.mkdirSync(kickoffRoot(root), { recursive: true })
    dir = fs.mkdtempSync(path.join(kickoffRoot(root), name + '-' + process.pid + '-'))
    store.lockdown(dir)
    fsx.writeJsonAtomic(path.join(dir, OWNER), { pid: process.pid, name, startedAt: Date.now() })
    const before = saved.refreshToken
    credstore.write(dir, payload.credentials)
    fsx.writeJsonAtomic(path.join(dir, '.claude.json'), { ...payload.identity, hasCompletedOnboarding: true }, { mode: 0o600 })

    const res = await run(dir)

    let after = null
    try { after = credstore.read(dir) } catch { keep = true }
    const rt = after && after.claudeAiOauth && after.claudeAiOauth.refreshToken
    if (rt && rt !== before) {
      try {
        profiles.updateCredentials(root, name, after, { ifRefreshToken: before })
      } catch (e) {
        keep = true
        return { ok: false, reason: 'its renewed login could not be saved yet (' + e.message + '); it will be retried' }
      }
    }
    return res
  } finally {
    if (dir && !keep) destroy(dir)
    release()
  }
}

module.exports = { startSession, cleanup, recover, destroy, runCli, envFor, ARGS, STRIP_ENV, RUN_TIMEOUT_MS, LOCK_STALE_MS, MAX_AGE_MS, kickoffRoot }
