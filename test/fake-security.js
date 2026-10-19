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
  delete(k) { const m = this.load(); const had = m.delete(k); this.save(m); return had },
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
    return { status: 0, stdout: 'class: "genp"\nattributes:\n', stderr: '' }
  }
  if (cmd === 'add-generic-password') {
    if (items.has(key) && !args.includes('-U')) {
      return { status: 45, stdout: '', stderr: 'security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.\n' }
    }
    const hex = opt(args, '-X')
    items.set(key, hex !== undefined ? Buffer.from(hex, 'hex').toString('utf8') : opt(args, '-w'))
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
