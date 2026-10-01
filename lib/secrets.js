const crypto = require('crypto')
const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const dpapi = require('./dpapi')
const keychain = require('./keychain')

const MAGIC = Buffer.from('CSW1', 'ascii')
const VERSION = 1
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

const SERVICE = 'claude-account-switcher'
const ACCOUNT = 'profile-encryption-key'

function backend() {
  if (process.platform === 'win32') return 'dpapi'
  if (process.platform === 'darwin') return 'keychain'
  return 'keyfile'
}

function run(cmd, args, input) {
  return cp.execFileSync(cmd, args, {
    encoding: 'utf8', input, timeout: 15000, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function has(cmd) {
  try {
    run(process.platform === 'win32' ? 'where' : 'which', [cmd])
    return true
  } catch { return false }
}

function keychainRead() {
  let hit
  try {
    hit = keychain.find(SERVICE, ACCOUNT, { secret: true })
  } catch (e) {
    throw new Error('Could not read the encryption key from the macOS Keychain: ' + e.message)
  }
  if (hit.state !== 'present') {
    if (hit.state === 'no-keychain') {
      throw new Error('This macOS user has no login Keychain, so saved accounts cannot be ' +
        'encrypted. Open Keychain Access and create one, then try again.')
    }
    return null
  }
  return Buffer.from(hit.value.trim(), 'base64')
}

function keychainWrite(key) {
  keychain.set(SERVICE, ACCOUNT, key.toString('base64'))
}

function secretToolRead() {
  try {
    const out = run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT])
    const trimmed = out.trim()
    return trimmed ? Buffer.from(trimmed, 'base64') : null
  } catch { return null }
}

function secretToolWrite(key) {
  run('secret-tool', ['store', '--label=Claude Account Switcher',
    'service', SERVICE, 'account', ACCOUNT], key.toString('base64'))
}

function keyFilePath(opts) {
  const home = (opts && opts.home) || os.homedir()
  return path.join(home, '.claude-switcher', 'masterkey')
}

function keyFileRead(opts) {
  try {
    const key = Buffer.from(fs.readFileSync(keyFilePath(opts), 'utf8').trim(), 'base64')
    return key.length === KEY_LEN ? key : null
  } catch { return null }
}

function keyFileWrite(key, opts) {
  const file = keyFilePath(opts)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, key.toString('base64') + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch {  }
}

let cachedKey

function masterKey(opts) {
  if (opts && opts.key) return opts.key
  if (cachedKey) return cachedKey

  const kind = (opts && opts.store) || (backend() === 'keychain' ? 'keychain'
    : has('secret-tool') ? 'secrettool' : 'keyfile')
  const read = () => (kind === 'keychain' ? keychainRead()
    : kind === 'secrettool' ? secretToolRead() : keyFileRead(opts))
  const write = (k) => (kind === 'keychain' ? keychainWrite(k)
    : kind === 'secrettool' ? secretToolWrite(k) : keyFileWrite(k, opts))

  let key = read()
  if (!key || key.length !== KEY_LEN) {
    key = crypto.randomBytes(KEY_LEN)
    write(key)
    const back = read()
    if (!back || !back.equals(key)) {
      throw new Error('Stored a new encryption key but could not read it back; refusing to ' +
        'encrypt anything that could not be decrypted later.')
    }
  }
  if (!(opts && (opts.home || opts.store))) cachedKey = key
  return key
}

function isAesBlob(blob) {
  return blob.length > MAGIC.length && blob.subarray(0, MAGIC.length).equals(MAGIC)
}

function protect(buf, opts) {
  if (backend() === 'dpapi' && !(opts && (opts.key || opts.store))) return dpapi.protect(buf)

  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(opts), iv)
  const body = Buffer.concat([cipher.update(buf), cipher.final()])
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, cipher.getAuthTag(), body])
}

function unprotect(blob, opts) {
  if (!isAesBlob(blob)) {
    if (process.platform !== 'win32') {
      throw new Error('This saved login was encrypted on Windows and cannot be read on ' +
        (process.platform === 'darwin' ? 'macOS' : 'this system') +
        '. Sign in to that account again to save it here.')
    }
    return dpapi.unprotect(blob)
  }

  const version = blob[MAGIC.length]
  if (version !== VERSION) {
    throw new Error('This saved login uses format version ' + version +
      ', which this build does not understand. Update the extension.')
  }
  const at = MAGIC.length + 1
  const iv = blob.subarray(at, at + IV_LEN)
  const tag = blob.subarray(at + IV_LEN, at + IV_LEN + TAG_LEN)
  const body = blob.subarray(at + IV_LEN + TAG_LEN)

  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(opts), iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new Error('This saved login could not be decrypted. It was encrypted by a ' +
      'different user or machine, or the key it used is gone.')
  }
}

function describe() {
  switch (backend()) {
    case 'dpapi': return 'Windows DPAPI (CurrentUser)'
    case 'keychain': return 'macOS Keychain + AES-256-GCM'
    default: return (has('secret-tool') ? 'libsecret' : 'key file (0600)') + ' + AES-256-GCM'
  }
}

module.exports = {
  protect, unprotect, backend, describe, isAesBlob, masterKey,
  MAGIC, VERSION, KEY_LEN,
  _test: { reset: () => { cachedKey = undefined } },
}
