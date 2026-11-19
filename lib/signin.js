const cp = require('child_process')
const fs = require('fs')
const path = require('path')

const credstore = require('./credstore')
const fsx = require('./fsx')
const store = require('./store')

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
const POLL_MS = 1500
const IDENTITY_GRACE_MS = 10000
const SLACK_MS = 2000
const PENDING_FILE = '.login-pending'
const URL_RE = /visit:\s*(https?:\/\/\S+)/i
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

const running = new Set()

function redactUrl(u) {
  try { const x = new URL(u); return x.origin + x.pathname } catch { return '(link)' }
}

function scrub(text, code) {
  let t = String(text || '').replace(ANSI_RE, '').replace(/https?:\/\/\S+/g, (u) => redactUrl(u))
  if (code) t = t.split(code).join('(code)')
  return t.trim()
}

function loginArgs(email) {
  const ok = typeof email === 'string' && /^[^\s@"'`$\\]+@[^\s@"'`$\\]+\.[^\s@"'`$\\]+$/.test(email.trim())
  return ['auth', 'login'].concat(ok ? ['--email', email.trim()] : [])
}

function envFor(configDir, base) {
  const env = { ...(base || process.env) }
  env.CLAUDE_CONFIG_DIR = configDir
  delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  delete env.CLAUDESWITCHER_SECURESTORAGE_CONFIG_DIR
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  return env
}

function prepareDir(dir, log) {
  fs.mkdirSync(dir, { recursive: true })
  const cfgPath = path.join(dir, '.claude.json')
  try {
    const { data, stamp } = fsx.readJsonForWrite(cfgPath)
    if (data.oauthAccount !== undefined || data.userID !== undefined) {
      delete data.oauthAccount
      delete data.userID
      fsx.writeJsonAtomic(cfgPath, data, { expect: stamp, mode: 0o600 })
    }
  } catch (e) {
    if (e.code === 'EUNREADABLEJSON') fs.rmSync(cfgPath, { force: true })
    else if (log) log('preparing ' + dir + ': ' + (e && e.message))
  }
  try { fsx.writeJsonAtomic(path.join(dir, PENDING_FILE), { pid: process.pid, startedAt: Date.now() }) } catch {  }
}

function finishDir(dir) {
  try { fs.rmSync(path.join(dir, PENDING_FILE), { force: true }) } catch {  }
}

function isPending(dir, timeoutMs) {
  const m = fsx.readJsonLoose(path.join(dir, PENDING_FILE), null)
  if (!m || !Number.isInteger(m.pid)) return false
  return fsx.pidAlive(m.pid) && Date.now() - (Number(m.startedAt) || 0) < (timeoutMs || LOGIN_TIMEOUT_MS) + 60000
}

function signedInAs(dir, status) {
  const id = store.identityFromFile(path.join(dir, '.claude.json'))
  return { accountUuid: (id && id.accountUuid) || null, email: (id && id.email) || (status && status.email) || null }
}

function freshIdentity(dir, startedAt) {
  const cfgPath = path.join(dir, '.claude.json')
  const id = store.identityFromFile(cfgPath)
  let st = null
  try { st = fsx.stamp(cfgPath) } catch {  }
  return id && (id.email || id.accountUuid) && st && st.mtimeMs >= startedAt - SLACK_MS ? id : null
}

function authStatusAsync(spawn, bin, env, timeoutMs) {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn(bin, ['auth', 'status', '--json'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { return resolve({ ok: false, error: e.message }) }
    const timer = setTimeout(() => { try { child.kill() } catch {  } }, timeoutMs || 30000)
    if (child.stdout) child.stdout.on('data', (d) => { out += d })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }) })
    child.on('close', () => {
      clearTimeout(timer)
      let j
      try { j = JSON.parse(out.trim()) } catch { return resolve({ ok: false, error: 'no status' }) }
      resolve({ ok: true, loggedIn: !!j.loggedIn, email: j.email || null, orgName: j.orgName || null })
    })
  })
}

function start(opts) {
  const o = opts || {}
  const spawn = o.spawn || cp.spawn
  const log = o.log || (() => {})
  const configDir = o.configDir
  const timeoutMs = o.timeoutMs || LOGIN_TIMEOUT_MS
  const pollMs = o.pollMs || POLL_MS
  const graceMs = o.graceMs === undefined ? IDENTITY_GRACE_MS : o.graceMs
  const env = envFor(configDir, o.env)

  let resolveUrl
  const url = new Promise((r) => { resolveUrl = r })
  let resolveDone
  const done = new Promise((r) => { resolveDone = r })

  let child = null
  let finished = false
  let timer = null
  let lastCode = null
  let exitCode = null
  let exitedAt = 0
  let lastLine = ''
  let confirmed = null
  let confirmedAt = 0
  let checking = false
  let polls = 0
  let lastMtime = 0
  const startedAt = Date.now()

  const finish = (result) => {
    if (finished) return
    finished = true
    clearInterval(timer)
    running.delete(handle)
    finishDir(configDir)
    resolveUrl(null)
    if (child && exitCode === null) {
      const kill = () => { if (exitCode === null) try { child.kill() } catch {  } }
      if (result.ok) setTimeout(kill, 5000).unref()
      else kill()
    }
    if (!result.ok) log('sign-in in ' + configDir + ' ended: ' + result.reason + (result.detail ? ' (' + result.detail + ')' : ''))
    resolveDone(result)
  }

  const handle = {
    url,
    done,
    sendCode(code) {
      if (finished || !child || !child.stdin || child.stdin.destroyed || exitCode !== null) return false
      const c = typeof code === 'string' ? code.trim() : ''
      if (!c || /[\r\n]/.test(c) || c.length > 4096) return false
      lastCode = c
      try { child.stdin.write(c + '\n') } catch { return false }
      log('sign-in in ' + configDir + ': code sent')
      return true
    },
    cancel() { finish({ ok: false, reason: 'cancelled', detail: null }) },
  }

  if (!configDir || typeof configDir !== 'string') {
    finish({ ok: false, reason: 'error', detail: 'no folder to sign in to' })
    return handle
  }
  if (!o.bin) {
    finish({ ok: false, reason: 'error', detail: 'claude was not found' })
    return handle
  }
  if (!o.spawn && process.platform === 'win32' && /\.(cmd|bat)$/i.test(o.bin)) {
    finish({ ok: false, reason: 'error', detail: 'claude is installed as a .cmd script, which needs a terminal' })
    return handle
  }

  try {
    prepareDir(configDir, log)
  } catch (e) {
    finish({ ok: false, reason: 'error', detail: e.message })
    return handle
  }

  running.add(handle)
  try {
    child = spawn(o.bin, loginArgs(o.email), { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: configDir })
  } catch (e) {
    finish({ ok: false, reason: 'error', detail: e.message })
    return handle
  }

  let buffered = ''
  let urlSeen = false
  const onText = (d) => {
    const text = String(d).replace(ANSI_RE, '')
    buffered = (buffered + text).slice(-8192)
    const m = urlSeen ? null : URL_RE.exec(buffered)
    if (m) {
      urlSeen = true
      resolveUrl(m[1])
      log('sign-in in ' + configDir + ': link ready (' + redactUrl(m[1]) + ')')
    }
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (lines.length) lastLine = lines[lines.length - 1]
  }
  if (child.stdout) { child.stdout.setEncoding('utf8'); child.stdout.on('data', onText) }
  if (child.stderr) { child.stderr.setEncoding('utf8'); child.stderr.on('data', onText) }
  if (child.stdin) child.stdin.on('error', () => {  })
  child.on('error', (e) => finish({ ok: false, reason: 'error', detail: scrub(e.message, lastCode) }))
  child.on('exit', (code, signal) => {
    exitCode = code === null ? (signal || 'killed') : code
    exitedAt = Date.now()
    resolveUrl(null)
    check()
  })

  const failExited = () => finish({ ok: false, reason: 'exited',
    detail: 'claude exited (' + exitCode + ')' + (lastLine ? ': ' + scrub(lastLine, lastCode) : '') })

  function check() {
    if (finished) return
    if (Date.now() - startedAt > timeoutMs) return finish({ ok: false, reason: 'timed out', detail: null })

    let st
    try { st = credstore.stat(configDir, o.credOpts) } catch (e) { log('sign-in check: ' + e.message); return }
    const fresh = st.exists && (st.modifiedMs === null || st.modifiedMs >= startedAt - SLACK_MS)
    if (fresh) {
      const id = freshIdentity(configDir, startedAt)
      if (id) return finish({ ok: true, email: id.email || null, accountUuid: id.accountUuid || null })
      if (confirmed) {
        if (Date.now() - confirmedAt > graceMs) return finish({ ok: true, email: confirmed.email || null, accountUuid: null })
        return
      }
      polls++
      const changed = st.modifiedMs !== lastMtime
      lastMtime = st.modifiedMs
      if (!checking && (changed || polls % 5 === 0 || exitCode !== null)) {
        checking = true
        authStatusAsync(spawn, o.bin, env).then((s) => {
          checking = false
          if (!finished && s.ok && s.loggedIn && !confirmed) { confirmed = s; confirmedAt = Date.now() }
        })
      }
    }
    if (exitCode !== null) {
      if (exitCode !== 0 && !fresh) return failExited()
      if (Date.now() - exitedAt > graceMs + pollMs) return confirmed ? finish({ ok: true, email: confirmed.email || null, accountUuid: null }) : failExited()
    }
  }
  timer = setInterval(check, pollMs)
  return handle
}

function cancelAll() { for (const h of [...running]) h.cancel() }

module.exports = {
  start, cancelAll, prepareDir, finishDir, isPending, signedInAs, loginArgs, envFor, redactUrl, scrub,
  LOGIN_TIMEOUT_MS, POLL_MS, IDENTITY_GRACE_MS, PENDING_FILE,
}
