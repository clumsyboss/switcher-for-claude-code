const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const REGISTRY = 'registry.json'

function defaultRoot() {
  return path.join(os.homedir(), '.claude-switcher')
}

function getRoot(vscode) {
  const cfg = vscode ? vscode.workspace.getConfiguration('claudeswitcher').get('root') : ''
  return cfg && cfg.trim() ? cfg.trim() : defaultRoot()
}

function lockdown(dir) {
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700) } catch {  }
    return
  }
  const user = process.env.USERNAME
  if (!user) return
  try {
    cp.execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], {
      stdio: 'ignore', windowsHide: true, timeout: 15000,
    })
  } catch {  }
}

function ensureRoot(root) {
  const fresh = !fs.existsSync(root)
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true })
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true })
  if (fresh) lockdown(root)
  return root
}

function registryPath(root) { return path.join(root, REGISTRY) }

function readRegistry(root) {
  ensureRoot(root)
  try {
    const r = JSON.parse(fs.readFileSync(registryPath(root), 'utf8'))
    if (!Array.isArray(r.accounts)) r.accounts = []
    return r
  } catch {
    return { accounts: [], active: null }
  }
}

function writeRegistry(root, reg) {
  ensureRoot(root)
  const tmp = registryPath(root) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8')
  fs.renameSync(tmp, registryPath(root))
}

function configDir(root, name) { return path.join(root, 'accounts', name) }

function validName(name) { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name) }

function addAccount(root, name) {
  const reg = readRegistry(root)
  if (reg.accounts.some((a) => a.name === name)) throw new Error(`Account "${name}" already exists.`)
  const dir = configDir(root, name)
  fs.mkdirSync(dir, { recursive: true })
  lockdown(dir)
  reg.accounts.push({ name, createdAt: new Date().toISOString() })
  if (!reg.active) reg.active = name
  writeRegistry(root, reg)
  return dir
}

function removeAccount(root, name) {
  const reg = readRegistry(root)
  reg.accounts = reg.accounts.filter((a) => a.name !== name)
  if (reg.active === name) reg.active = reg.accounts.length ? reg.accounts[0].name : null
  writeRegistry(root, reg)
  try { require('./credstore').remove(configDir(root, name)) } catch {  }
  fs.rmSync(configDir(root, name), { recursive: true, force: true })
}

function setActive(root, name) {
  const reg = readRegistry(root)
  reg.active = name
  writeRegistry(root, reg)
}

function getActive(root) { return readRegistry(root).active }

function identity(root, name) {
  const p = path.join(configDir(root, name), '.claude.json')
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const o = j.oauthAccount
    if (!o) return null
    return {
      email: o.emailAddress || null,
      org: o.organizationName || null,
      displayName: o.displayName || null,
      tier: o.userRateLimitTier || o.organizationRateLimitTier || null,
    }
  } catch { return null }
}

function isAuthed(root, name) {
  try { return require('./credstore').exists(configDir(root, name)) } catch { return false }
}

module.exports = {
  defaultRoot, getRoot, ensureRoot, readRegistry, writeRegistry,
  configDir, validName, addAccount, removeAccount, setActive, getActive,
  identity, isAuthed, lockdown,
}

function nameForConfigDir(root, dir) {
  if (!dir) return null
  const want = path.resolve(dir).toLowerCase()
  const reg = readRegistry(root)
  for (const a of reg.accounts) {
    if (path.resolve(configDir(root, a.name)).toLowerCase() === want) return a.name
  }
  return null
}

module.exports.nameForConfigDir = nameForConfigDir

const MODES = ['login', 'window', 'global']

function getMode(root) {
  const m = readRegistry(root).mode
  return MODES.includes(m) ? m : 'global'
}

function setMode(root, mode) {
  const reg = readRegistry(root)
  reg.mode = MODES.includes(mode) ? mode : 'global'
  writeRegistry(root, reg)
  return reg.mode
}

module.exports.getMode = getMode
module.exports.setMode = setMode

function identityFromFile(p) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const o = j.oauthAccount
    if (!o) return null
    return {
      email: o.emailAddress || null,
      org: o.organizationName || null,
      displayName: o.displayName || null,
      tier: o.userRateLimitTier || o.organizationRateLimitTier || null,
    }
  } catch { return null }
}

module.exports.identityFromFile = identityFromFile

const DEFAULT_NAME = '(default)'

function validIcon(icon) {
  return typeof icon === 'string' && /^[a-zA-Z0-9-]{1,40}(\+[a-zA-Z0-9-]{1,40})?$/.test(icon)
}

function iconText(icon) {
  return String(icon || 'account').split('+').map((i) => '$(' + i + ')').join('')
}

const COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']
function validColor(color) { return COLORS.indexOf(color) !== -1 }

function validLabel(label) { return typeof label === 'string' && label.trim().length > 0 && label.length <= 40 }

function displayOf(root, name) {
  const reg = readRegistry(root)
  if (name === DEFAULT_NAME) {
    const d = reg.defaults || {}
    return { label: d.label || DEFAULT_NAME, icon: d.icon || 'home', color: validColor(d.color) ? d.color : null }
  }
  const a = reg.accounts.find((x) => x.name === name)
  const d = (reg.display || {})[name] || {}
  const color = (a && a.color) || d.color
  return { label: (a && a.label) || d.label || name, icon: (a && a.icon) || d.icon || 'account',
    color: validColor(color) ? color : null }
}

function mergeDisplay(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k]
    else target[k] = v
  }
  return target
}

function setDisplay(root, name, patch) {
  const reg = readRegistry(root)
  if (name === DEFAULT_NAME) {
    reg.defaults = mergeDisplay({ ...(reg.defaults || {}) }, patch)
  } else {
    if (!validName(name)) throw new Error('Invalid account name: ' + name)
    const a = reg.accounts.find((x) => x.name === name)
    if (a) mergeDisplay(a, patch)
    else reg.display = { ...(reg.display || {}), [name]: mergeDisplay({ ...((reg.display || {})[name] || {}) }, patch) }
  }
  writeRegistry(root, reg)
  return displayOf(root, name)
}

module.exports.DEFAULT_NAME = DEFAULT_NAME
module.exports.validIcon = validIcon
module.exports.COLORS = COLORS
module.exports.validColor = validColor
module.exports.iconText = iconText
module.exports.validLabel = validLabel
module.exports.displayOf = displayOf
module.exports.setDisplay = setDisplay

function getRemote(root, name) {
  const r = readRegistry(root).remote || {}
  return r[name] === 'off' ? 'off' : 'on'
}

function setRemote(root, name, value) {
  const reg = readRegistry(root)
  reg.remote = { ...(reg.remote || {}) }
  if (value === 'off') reg.remote[name] = 'off'
  else delete reg.remote[name]
  writeRegistry(root, reg)
  return getRemote(root, name)
}

module.exports.getRemote = getRemote
module.exports.setRemote = setRemote

function getArtifacts(root, name) {
  const r = readRegistry(root).artifacts || {}
  return r[name] === 'off' ? 'off' : 'on'
}

function setArtifacts(root, name, value) {
  const reg = readRegistry(root)
  reg.artifacts = { ...(reg.artifacts || {}) }
  if (value === 'off') reg.artifacts[name] = 'off'
  else delete reg.artifacts[name]
  writeRegistry(root, reg)
  return getArtifacts(root, name)
}

function artifactsManaged(root) {
  return Object.keys(readRegistry(root).artifacts || {}).length > 0
}

module.exports.getArtifacts = getArtifacts
module.exports.setArtifacts = setArtifacts
module.exports.artifactsManaged = artifactsManaged

function pinKey(folder) {
  if (!folder) return null
  let p = path.resolve(folder)
  while (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p)) p = p.slice(0, -1)
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function getPins(root) { return { ...(readRegistry(root).pins || {}) } }

function getPin(root, folder) {
  const key = pinKey(folder)
  if (!key) return null
  const v = (readRegistry(root).pins || {})[key]
  return typeof v === 'string' && validName(v) ? v : null
}

function setPin(root, folder, name) {
  const key = pinKey(folder)
  if (!key) throw new Error('No folder to pin')
  if (name !== null && !validName(name)) throw new Error('Invalid account name: ' + name)
  const reg = readRegistry(root)
  reg.pins = { ...(reg.pins || {}) }
  if (name) reg.pins[key] = name
  else delete reg.pins[key]
  writeRegistry(root, reg)
  return getPin(root, folder)
}

function unpinAccount(root, name) {
  const reg = readRegistry(root)
  const before = Object.keys(reg.pins || {}).length
  reg.pins = Object.fromEntries(Object.entries(reg.pins || {}).filter(([, v]) => v !== name))
  writeRegistry(root, reg)
  return before - Object.keys(reg.pins).length
}

module.exports.pinKey = pinKey
module.exports.getPins = getPins
module.exports.getPin = getPin
module.exports.setPin = setPin
module.exports.unpinAccount = unpinAccount
