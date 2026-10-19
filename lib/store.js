const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const fsx = require('./fsx')
const locks = require('./locks')

const REGISTRY = 'registry.json'

function defaultRoot() {
  return path.join(os.homedir(), '.claude-switcher')
}

function getRoot(vscode) {
  const cfg = vscode ? vscode.workspace.getConfiguration('claudeswitcher').get('root') : ''
  const v = cfg && cfg.trim()
  if (!v) return defaultRoot()
  return v === '~' || /^~[\\/]/.test(v) ? path.join(os.homedir(), v.slice(1)) : v
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
  else if (process.platform !== 'win32') {
    try { if (fs.statSync(root).mode & 0o077) fs.chmodSync(root, 0o700) } catch {  }
  }
  return root
}

function registryPath(root) { return path.join(root, REGISTRY) }

class RegistryUnreadableError extends Error {
  constructor(file, why) {
    super(file + " has an error (" + why + "). Fix it, or restore registry.json.bak, and try again. " +
      'Nothing was changed.')
    this.code = 'EREGISTRY'
  }
}

const lastError = new Map()

function emptyRegistry() { return { accounts: [], active: null } }

function validName(name) { return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name) }

function validIcon(icon) {
  return typeof icon === 'string' && /^[a-zA-Z0-9-]{1,40}(\+[a-zA-Z0-9-]{1,40})?$/.test(icon) &&
    !icon.split('+').some((p) => p in Object.prototype)
}

const COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']
function validColor(color) { return COLORS.indexOf(color) !== -1 }

function validLabel(label) {
  return typeof label === 'string' && label.trim().length > 0 && label.length <= 40 && !/[\r\n]/.test(label)
}

const MODES = ['login', 'window', 'global']
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

function cleanDisplay(d) {
  const out = {}
  if (!isObj(d)) return out
  if (validLabel(d.label)) out.label = d.label
  if (validIcon(d.icon)) out.icon = d.icon
  if (validColor(d.color)) out.color = d.color
  return out
}

function sanitize(raw) {
  const reg = isObj(raw) ? { ...raw } : {}
  reg.accounts = (Array.isArray(reg.accounts) ? reg.accounts : [])
    .filter((a) => isObj(a) && validName(a.name))
    .map((a) => ({ ...cleanDisplay(a), name: a.name, ...(typeof a.createdAt === 'string' ? { createdAt: a.createdAt } : {}) }))
  reg.active = validName(reg.active) ? reg.active : null
  if (reg.mode !== undefined && !MODES.includes(reg.mode)) delete reg.mode

  const named = (o, ok) => Object.fromEntries(Object.entries(isObj(o) ? o : {}).filter(([k, v]) => validName(k) && ok(v)))
  if (reg.display !== undefined) reg.display = Object.fromEntries(Object.entries(named(reg.display, isObj)).map(([k, v]) => [k, cleanDisplay(v)]))
  if (reg.defaults !== undefined) reg.defaults = cleanDisplay(reg.defaults)
  if (reg.remote !== undefined) reg.remote = named(reg.remote, (v) => v === 'off')
  if (reg.artifacts !== undefined) reg.artifacts = named(reg.artifacts, (v) => v === 'off')
  if (reg.pins !== undefined) {
    reg.pins = Object.fromEntries(Object.entries(isObj(reg.pins) ? reg.pins : {})
      .filter(([k, v]) => typeof k === 'string' && path.isAbsolute(k) && validName(v)))
  }
  if (reg.liveLog !== undefined) {
    reg.liveLog = (Array.isArray(reg.liveLog) ? reg.liveLog : [])
      .filter((e) => isObj(e) && validName(e.name) && Number.isFinite(e.at))
  }
  return reg
}

function readRegistryStrict(root) {
  try {
    const { data } = fsx.readJsonForWrite(registryPath(root))
    lastError.delete(root)
    return sanitize(Object.keys(data).length ? data : emptyRegistry())
  } catch (e) {
    if (e.code === 'EUNREADABLEJSON') {
      const err = new RegistryUnreadableError(registryPath(root), e.why)
      lastError.set(root, err.message)
      throw err
    }
    throw e
  }
}

const readCache = new Map()

function statKey(file) {
  try {
    const st = fs.statSync(file)
    return st.size + ':' + st.mtimeMs + ':' + st.ino
  } catch { return null }
}

function readRegistry(root) {
  const key = statKey(registryPath(root))
  const hit = readCache.get(root)
  if (key && hit && hit.key === key) return structuredClone(hit.reg)
  try {
    const reg = readRegistryStrict(root)
    if (key && statKey(registryPath(root)) === key) readCache.set(root, { key, reg: structuredClone(reg) })
    else readCache.delete(root)
    return reg
  } catch (e) {
    readCache.delete(root)
    if (e.code === 'EREGISTRY') return sanitize(emptyRegistry())
    throw e
  }
}

function registryError(root) {
  if (!lastError.has(root)) return null
  try { readRegistryStrict(root) } catch {  }
  return lastError.get(root) || null
}

function writeRaw(root, reg, previousText) {
  ensureRoot(root)
  if (previousText) {
    try { fsx.writeFileAtomic(registryPath(root) + '.bak', previousText, { mode: 0o600, forceMode: true }) } catch {  }
  }
  fsx.writeJsonAtomic(registryPath(root), reg, { mode: 0o600, forceMode: true })
}

function updateRegistry(root, fn) {
  ensureRoot(root)
  const release = locks.acquireSync(root, 'registry', { staleMs: 10000, waitMs: 6000 })
  if (!release) throw new Error('registry.json is busy in another window. Try again in a moment.')
  try {
    const before = readRegistryStrict(root)
    let previousText = null
    try { previousText = fs.readFileSync(registryPath(root), 'utf8') } catch {  }
    const reg = JSON.parse(JSON.stringify(before))
    const out = fn(reg)
    const next = sanitize(reg)
    if (JSON.stringify(next) !== JSON.stringify(before)) writeRaw(root, next, previousText)
    return out
  } finally {
    release()
  }
}

function writeRegistry(root, reg) {
  return updateRegistry(root, (r) => {
    for (const k of Object.keys(r)) delete r[k]
    Object.assign(r, reg)
  })
}

function configDir(root, name) {
  if (!validName(name)) throw new Error('Invalid account name: ' + name)
  return path.join(root, 'accounts', name)
}

function addAccount(root, name) {
  const dir = configDir(root, name)
  updateRegistry(root, (reg) => {
    if (reg.accounts.some((a) => a.name === name)) throw new Error(`Account "${name}" already exists.`)
    reg.accounts.push({ name, createdAt: new Date().toISOString() })
    if (!reg.active) reg.active = name
  })
  fs.mkdirSync(dir, { recursive: true })
  lockdown(dir)
  return dir
}

function removeAccount(root, name) {
  const dir = configDir(root, name)
  require('./credstore').remove(dir)
  updateRegistry(root, (reg) => {
    reg.accounts = reg.accounts.filter((a) => a.name !== name)
    if (reg.active === name) reg.active = reg.accounts.length ? reg.accounts[0].name : null
  })
  fs.rmSync(dir, { recursive: true, force: true })
}

function setActive(root, name) {
  updateRegistry(root, (reg) => { reg.active = name })
}

function getActive(root) { return readRegistry(root).active }

function identity(root, name) {
  return identityFromFile(path.join(configDir(root, name), '.claude.json'))
}

function isAuthed(root, name) {
  try { return require('./credstore').exists(configDir(root, name)) } catch { return false }
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

function getMode(root) {
  const m = readRegistry(root).mode
  return MODES.includes(m) ? m : 'global'
}

function setMode(root, mode) {
  const next = MODES.includes(mode) ? mode : 'global'
  updateRegistry(root, (reg) => { reg.mode = next })
  return next
}

function identityFromFile(p) {
  const j = fsx.readJsonLoose(p, null)
  const o = j && j.oauthAccount
  if (!isObj(o)) return null
  const str = (v) => (typeof v === 'string' && v ? v : null)
  return {
    email: str(o.emailAddress),
    org: str(o.organizationName),
    displayName: str(o.displayName),
    tier: str(o.userRateLimitTier) || str(o.organizationRateLimitTier),
    accountUuid: str(o.accountUuid),
  }
}

const DEFAULT_NAME = '(default)'

function iconText(icon) {
  return String(icon || 'account').split('+').map((i) => '$(' + i + ')').join('')
}

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
    if (!['label', 'icon', 'color'].includes(k)) continue
    if (v === null) delete target[k]
    else target[k] = v
  }
  return target
}

function setDisplay(root, name, patch) {
  if (name !== DEFAULT_NAME && !validName(name)) throw new Error('Invalid account name: ' + name)
  const clean = {}
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === null) clean[k] = null
    else if (k === 'label' && validLabel(v)) clean.label = v
    else if (k === 'icon' && validIcon(v)) clean.icon = v
    else if (k === 'color' && validColor(v)) clean.color = v
  }
  updateRegistry(root, (reg) => {
    if (name === DEFAULT_NAME) {
      reg.defaults = mergeDisplay({ ...(reg.defaults || {}) }, clean)
    } else {
      const a = reg.accounts.find((x) => x.name === name)
      if (a) mergeDisplay(a, clean)
      else reg.display = { ...(reg.display || {}), [name]: mergeDisplay({ ...((reg.display || {})[name] || {}) }, clean) }
    }
  })
  return displayOf(root, name)
}

function getRemote(root, name) {
  const r = readRegistry(root).remote || {}
  return r[name] === 'off' ? 'off' : 'on'
}

function setRemote(root, name, value) {
  if (!validName(name)) throw new Error('Invalid account name: ' + name)
  updateRegistry(root, (reg) => {
    reg.remote = { ...(reg.remote || {}) }
    if (value === 'off') reg.remote[name] = 'off'
    else delete reg.remote[name]
  })
  return getRemote(root, name)
}

function remoteManaged(root) {
  return Object.keys(readRegistry(root).remote || {}).length > 0
}

function getArtifacts(root, name) {
  const r = readRegistry(root).artifacts || {}
  return r[name] === 'off' ? 'off' : 'on'
}

function setArtifacts(root, name, value) {
  if (!validName(name)) throw new Error('Invalid account name: ' + name)
  updateRegistry(root, (reg) => {
    reg.artifacts = { ...(reg.artifacts || {}) }
    if (value === 'off') reg.artifacts[name] = 'off'
    else delete reg.artifacts[name]
  })
  return getArtifacts(root, name)
}

function artifactsManaged(root) {
  return Object.keys(readRegistry(root).artifacts || {}).length > 0
}

const LIVE_LOG_MAX = 300
function getLiveLog(root) { return readRegistry(root).liveLog || [] }

function recordLive(root, name, at) {
  if (!validName(name)) return false
  const log = getLiveLog(root)
  if (log.length && log[log.length - 1].name === name) return false
  return updateRegistry(root, (reg) => {
    const cur = reg.liveLog || []
    if (cur.length && cur[cur.length - 1].name === name) return false
    reg.liveLog = cur.concat([{ name, at: at || Date.now() }]).slice(-LIVE_LOG_MAX)
    return true
  })
}

function pinKey(folder) {
  if (!folder) return null
  let p = path.resolve(folder)
  try { p = fs.realpathSync.native(p) } catch {  }
  while (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p)) p = p.slice(0, -1)
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function findPinKey(pins, folder) {
  const key = pinKey(folder)
  if (!key) return null
  if (Object.prototype.hasOwnProperty.call(pins, key)) return key
  return Object.keys(pins).find((k) => pinKey(k) === key) || null
}

function getPins(root) { return { ...(readRegistry(root).pins || {}) } }

function getPin(root, folder) {
  const pins = readRegistry(root).pins || {}
  const key = findPinKey(pins, folder)
  const v = key ? pins[key] : null
  return validName(v) ? v : null
}

function setPin(root, folder, name) {
  const key = pinKey(folder)
  if (!key) throw new Error('No folder to pin')
  if (name !== null && !validName(name)) throw new Error('Invalid account name: ' + name)
  updateRegistry(root, (reg) => {
    reg.pins = { ...(reg.pins || {}) }
    const old = findPinKey(reg.pins, folder)
    if (old && old !== key) delete reg.pins[old]
    if (name) reg.pins[key] = name
    else delete reg.pins[key]
  })
  return getPin(root, folder)
}

function unpinAccount(root, name) {
  return updateRegistry(root, (reg) => {
    const before = Object.keys(reg.pins || {}).length
    reg.pins = Object.fromEntries(Object.entries(reg.pins || {}).filter(([, v]) => v !== name))
    return before - Object.keys(reg.pins).length
  })
}

module.exports = {
  defaultRoot, getRoot, ensureRoot, lockdown, registryPath,
  readRegistry, readRegistryStrict, writeRegistry, updateRegistry, registryError, sanitize, RegistryUnreadableError,
  configDir, validName, addAccount, removeAccount, setActive, getActive, identity, isAuthed, nameForConfigDir,
  getMode, setMode, identityFromFile,
  DEFAULT_NAME, validIcon, COLORS, validColor, iconText, validLabel, displayOf, setDisplay,
  getRemote, setRemote, remoteManaged, getArtifacts, setArtifacts, artifactsManaged,
  getLiveLog, recordLive,
  pinKey, getPins, getPin, setPin, unpinAccount,
}
