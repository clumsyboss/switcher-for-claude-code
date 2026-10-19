const cp = require('child_process')
const fs = require('fs')

const TIMEOUT_MS = 15000
const QUICK_TIMEOUT_MS = 5000

const SECURITY_BIN = fs.existsSync('/usr/bin/security') ? '/usr/bin/security' : 'security'
const STDIN_LIMIT = 4032

class KeychainError extends Error {
  constructor(kind, message) {
    super(message)
    this.kind = kind
  }
}

function defaultRunner(args, input, timeout) {
  return cp.spawnSync(SECURITY_BIN, args, {
    input, encoding: 'utf8', timeout: timeout || TIMEOUT_MS, windowsHide: true,
  })
}

let runner = defaultRunner

const BY_STATUS = { 0: 'ok', 44: 'absent', 36: 'locked', 37: 'no-keychain', 50: 'no-keychain', 45: 'duplicate', 128: 'canceled' }

function classify(r) {
  if (r.error) {
    if (r.error.code === 'ENOENT') return 'no-keychain'
    return r.error.code === 'ETIMEDOUT' ? 'timeout' : 'error'
  }
  if (Number.isInteger(r.status) && BY_STATUS[r.status]) return BY_STATUS[r.status]
  const text = String(r.stderr || '').toLowerCase()
  if (text.includes('no default keychain') || text.includes('default keychain could not be found') ||
    text.includes('keychain could not be found') || text.includes('no such keychain')) return 'no-keychain'
  if (text.includes('interaction is not allowed') || text.includes('locked')) return 'locked'
  if (text.includes('already exists')) return 'duplicate'
  if (text.includes('could not be found')) return 'absent'
  if (text.includes('cancel')) return 'canceled'
  return r.status === 0 ? 'ok' : 'error'
}

function fail(kind, r) {
  const detail = String((r && (r.stderr || (r.error && r.error.message))) || '').trim()
  switch (kind) {
    case 'locked':
      return new KeychainError(kind, 'The macOS login Keychain is locked. Unlock it (log out and ' +
        'back in, or open Keychain Access) and try again.')
    case 'canceled':
      return new KeychainError(kind, 'Keychain access was denied. When macOS asks, choose ' +
        '"Always Allow", then try again.')
    case 'timeout':
      return new KeychainError(kind, 'The macOS Keychain did not answer in time. If it asked for your ' +
        'password or for access, answer it and try again.')
    default:
      return new KeychainError(kind, 'Keychain error' +
        (r && r.status !== undefined && r.status !== null ? ' (security exited ' + r.status + ')' : '') +
        (detail ? ': ' + detail : ''))
  }
}

function parseModified(text) {
  const m = /"mdat"<timedate>=\S*\s+"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/.exec(text || '')
  if (!m) return 0
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
}

function find(service, account, opts) {
  const secret = !!(opts && opts.secret)
  const args = ['find-generic-password', '-a', account, '-s', service]
  if (secret) args.push('-w')
  const r = runner(args, undefined, secret ? TIMEOUT_MS : QUICK_TIMEOUT_MS)
  const kind = classify(r)
  if (kind === 'absent' || kind === 'no-keychain') return { state: kind }
  if (kind !== 'ok') throw fail(kind, r)
  if (secret) return { state: 'present', value: String(r.stdout || '').replace(/\r?\n$/, '') }
  return { state: 'present', modifiedMs: parseModified(String(r.stdout || '') + String(r.stderr || '')) }
}

function assertSafe(label, v) {
  if (typeof v !== 'string' || !v || /["\\\r\n]/.test(v)) {
    throw new KeychainError('error', 'Refusing to use ' + label + ' ' + JSON.stringify(v) + ' with the keychain.')
  }
}

function write(service, account, value, update) {
  assertSafe('service', service)
  assertSafe('account', account)
  const hex = Buffer.from(String(value), 'utf8').toString('hex')
  const u = update ? ' -U' : ''
  const line = 'add-generic-password' + u + ' -a "' + account + '" -s "' + service + '" -X "' + hex + '"\n'
  const args = ['add-generic-password', ...(update ? ['-U'] : []), '-a', account, '-s', service, '-X', hex]
  const r = line.length <= STDIN_LIMIT ? runner(['-i'], line) : runner(args)
  return { kind: classify(r), r }
}

function set(service, account, value) {
  const { kind, r } = write(service, account, value, true)
  if (kind !== 'ok') throw fail(kind, r)
}

function add(service, account, value) {
  const { kind, r } = write(service, account, value, false)
  if (kind === 'ok' || kind === 'duplicate') return kind
  throw fail(kind, r)
}

function remove(service, account) {
  const r = runner(['delete-generic-password', '-a', account, '-s', service])
  const kind = classify(r)
  if (kind === 'ok') return true
  if (kind === 'absent' || kind === 'no-keychain') return false
  throw fail(kind, r)
}

module.exports = {
  find, set, add, remove, classify, parseModified, KeychainError, STDIN_LIMIT, SECURITY_BIN,
  _test: {
    setRunner(fn) { runner = fn || defaultRunner },
  },
}
