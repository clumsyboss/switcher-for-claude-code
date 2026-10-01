const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const keychain = require('./keychain')

const FILE = '.credentials.json'
const SERVICE_BASE = 'Claude Code'
const SERVICE_SUFFIX = '-credentials'
const FALLBACK_ACCOUNT = 'claude-code-user'
const ACCOUNT_RE = /^[a-zA-Z0-9._-]+$/

function platform(opts) { return (opts && opts.platform) || process.platform }
function env(opts) { return (opts && opts.env) || process.env }
function home(opts) { return (opts && opts.home) || os.homedir() }

function usesKeychain(opts) { return platform(opts) === 'darwin' }

function storageDir(configDir, opts) {
  const ssd = env(opts).CLAUDE_SECURESTORAGE_CONFIG_DIR
  if (ssd !== undefined) return ssd || path.join(home(opts), '.claude')
  return configDir || path.join(home(opts), '.claude')
}

function filePath(configDir, opts) { return path.join(storageDir(configDir, opts), FILE) }

function service(configDir, opts) {
  const ssd = env(opts).CLAUDE_SECURESTORAGE_CONFIG_DIR
  const isDefault = ssd !== undefined ? !ssd : !configDir
  const input = ssd !== undefined ? ssd : (configDir || path.join(home(opts), '.claude'))
  const tail = isDefault ? ''
    : '-' + crypto.createHash('sha256').update(input.normalize('NFC')).digest('hex').substring(0, 8)
  return SERVICE_BASE + SERVICE_SUFFIX + tail
}

function account(opts) {
  let n
  try { n = env(opts).USER || os.userInfo().username } catch { n = FALLBACK_ACCOUNT }
  return n && ACCOUNT_RE.test(n) ? n : FALLBACK_ACCOUNT
}

function parseValue(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  try { return JSON.parse(text) } catch {  }
  if (/^(?:[0-9a-fA-F]{2})+$/.test(text)) {
    try { return JSON.parse(Buffer.from(text, 'hex').toString('utf8')) } catch {  }
  }
  return null
}

function readFile(configDir, opts) {
  try { return JSON.parse(fs.readFileSync(filePath(configDir, opts), 'utf8')) } catch { return null }
}

function writeFile(configDir, obj, opts) {
  const file = filePath(configDir, opts)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch {  }
}

function removeFile(configDir, opts) {
  try { fs.rmSync(filePath(configDir, opts), { force: true }); return true } catch { return false }
}

function fileModified(configDir, opts) {
  try { return fs.statSync(filePath(configDir, opts)).mtimeMs } catch { return 0 }
}

function read(configDir, opts) {
  if (usesKeychain(opts)) {
    const hit = keychain.find(service(configDir, opts), account(opts), { secret: true })
    if (hit.state === 'present') {
      const v = parseValue(hit.value)
      if (v) return v
    }
  }
  return readFile(configDir, opts)
}

function write(configDir, obj, opts) {
  if (!usesKeychain(opts)) {
    writeFile(configDir, obj, opts)
    return { where: 'file' }
  }

  const svc = service(configDir, opts)
  const acct = account(opts)
  const before = keychain.find(svc, acct)
  if (before.state === 'no-keychain') {
    writeFile(configDir, obj, opts)
    return { where: 'file' }
  }

  keychain.set(svc, acct, JSON.stringify(obj))

  const back = keychain.find(svc, acct, { secret: true })
  const got = back.state === 'present' ? parseValue(back.value) : null
  const want = obj && obj.claudeAiOauth && obj.claudeAiOauth.refreshToken
  if (!got || (want && !(got.claudeAiOauth && got.claudeAiOauth.refreshToken === want))) {
    throw new keychain.KeychainError('error',
      'Wrote the login to the Keychain but could not read the same login back.')
  }

  if (before.state === 'absent') removeFile(configDir, opts)
  return { where: 'keychain' }
}

function remove(configDir, opts) {
  let removed = false
  if (usesKeychain(opts)) removed = keychain.remove(service(configDir, opts), account(opts))
  const hadFile = fs.existsSync(filePath(configDir, opts))
  removeFile(configDir, opts)
  return removed || hadFile
}

function stat(configDir, opts) {
  if (usesKeychain(opts)) {
    const hit = keychain.find(service(configDir, opts), account(opts))
    if (hit.state === 'present') {
      const t = hit.modifiedMs || fileModified(configDir, opts) || Date.now()
      return { exists: true, modifiedMs: t, where: 'keychain' }
    }
  }
  const t = fileModified(configDir, opts)
  return t ? { exists: true, modifiedMs: t, where: 'file' } : { exists: false, modifiedMs: 0, where: null }
}

function exists(configDir, opts) { return stat(configDir, opts).exists }

function describe(configDir, opts) {
  if (usesKeychain(opts)) {
    return 'Keychain "' + service(configDir, opts) + '" (account ' + account(opts) + '), then ' +
      filePath(configDir, opts)
  }
  return filePath(configDir, opts)
}

module.exports = {
  read, write, remove, stat, exists, describe,
  service, account, filePath, usesKeychain, parseValue,
  FILE,
}
