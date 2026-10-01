const cp = require('child_process')

const TIMEOUT_MS = 15000
const STDIN_LIMIT = 4032

class KeychainError extends Error {
  constructor(kind, message) {
    super(message)
    this.kind = kind
  }
}

function defaultRunner(args, input) {
  return cp.spawnSync('security', args, {
    input, encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true,
  })
}

let runner = defaultRunner

function classify(r) {
  if (r.error) return r.error.code === 'ENOENT' ? 'no-keychain' : 'error'
  const text = String(r.stderr || '').toLowerCase()
  if (r.status === 0) return 'ok'
  if (r.status === 44 || text.includes('could not be found')) return 'absent'
  if (r.status === 36 || text.includes('interaction is not allowed') || text.includes('locked')) return 'locked'
  if (r.status === 37 || r.status === 50 || text.includes('no default keychain')) return 'no-keychain'
  if (r.status === 128 || text.includes('cancel')) return 'canceled'
  return 'error'
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
  const r = runner(args)
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

function set(service, account, value) {
  assertSafe('service', service)
  assertSafe('account', account)
  const hex = Buffer.from(String(value), 'utf8').toString('hex')
  const line = 'add-generic-password -U -a "' + account + '" -s "' + service + '" -X "' + hex + '"\n'
  const r = line.length <= STDIN_LIMIT
    ? runner(['-i'], line)
    : runner(['add-generic-password', '-U', '-a', account, '-s', service, '-X', hex])
  const kind = classify(r)
  if (kind !== 'ok') throw fail(kind, r)
}

function remove(service, account) {
  const r = runner(['delete-generic-password', '-a', account, '-s', service])
  const kind = classify(r)
  if (kind === 'ok') return true
  if (kind === 'absent' || kind === 'no-keychain') return false
  throw fail(kind, r)
}

module.exports = {
  find, set, remove, classify, parseModified, KeychainError, STDIN_LIMIT,
  _test: {
    setRunner(fn) { runner = fn || defaultRunner },
  },
}
