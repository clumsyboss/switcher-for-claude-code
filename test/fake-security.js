const fs = require('fs')
const os = require('os')
const path = require('path')
const keychain = require('../lib/keychain')

if (!process.env.FAKE_HOME_DIR) {
  process.env.FAKE_HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-home-'))
  process.env.HOME = process.env.FAKE_HOME_DIR
  process.env.USERPROFILE = process.env.FAKE_HOME_DIR
}

if (!process.env.FAKE_KEYCHAIN_FILE) {
  process.env.FAKE_KEYCHAIN_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-keychain-')), 'items.json')
  process.env.NODE_OPTIONS = ((process.env.NODE_OPTIONS || '') + ' --require ' + JSON.stringify(__filename)).trim()
}
const FILE = process.env.FAKE_KEYCHAIN_FILE

const items = {
  load() { try { return new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))) } catch { return new Map() } },
  save(m) { fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(m)), { mode: 0o600 }) },
  has(k) { return this.load().has(k) },
  get(k) { return this.load().get(k) },
  set(k, v) { const m = this.load(); m.set(k, v); this.save(m) },
  delete(k) { const m = this.load(); const had = m.delete(k); m.delete(k + MDAT); this.save(m); return had },
}
const MDAT = '\0mdat'

function stamp(ms) {
  const d = new Date(ms)
  const p = (n, w) => String(n).padStart(w || 2, '0')
  return p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z'
}
const NOT_FOUND = 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n'

function opt(args, flag) { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }

function splitLine(line) {
  const out = []
  const re = /"([^"]*)"|(\S+)/g
  let m
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2])
  return out
}

function exec(args) {
  const [cmd] = args
  const key = opt(args, '-s') + '\0' + opt(args, '-a')
  if (cmd === 'find-generic-password') {
    if (!items.has(key)) return { status: 44, stdout: '', stderr: NOT_FOUND }
    if (args.includes('-w')) return { status: 0, stdout: items.get(key) + '\n', stderr: '' }
    const t = stamp(Number(items.get(key + MDAT)) || Date.now())
    return {
      status: 0,
      stdout: 'keychain: "/Users/someone/Library/Keychains/login.keychain-db"\nclass: "genp"\nattributes:\n' +
        '    "mdat"<timedate>=0x' + Buffer.from(t).toString('hex').toUpperCase() + '00  "' + t + '\\000"\n' +
        '    "svce"<blob>="' + opt(args, '-s') + '"\n',
      stderr: '',
    }
  }
  if (cmd === 'add-generic-password') {
    if (items.has(key) && !args.includes('-U')) {
      return { status: 45, stdout: '', stderr: 'security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.\n' }
    }
    const hex = opt(args, '-X')
    const m = items.load()
    m.set(key, hex !== undefined ? Buffer.from(hex, 'hex').toString('utf8') : opt(args, '-w'))
    m.set(key + MDAT, String(Math.floor(Date.now() / 1000) * 1000))
    items.save(m)
    return { status: 0, stdout: '', stderr: '' }
  }
  if (cmd === 'delete-generic-password') {
    if (!items.delete(key)) return { status: 44, stdout: '', stderr: NOT_FOUND }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { status: 1, stdout: '', stderr: 'fake security: unsupported ' + cmd + '\n' }
}

function install() {
  keychain._test.setRunner((args, input) => {
    if (args[0] === '-i') return exec(splitLine(String(input || '').trim()))
    return exec(args)
  })
}
install()

module.exports = { items, install }
