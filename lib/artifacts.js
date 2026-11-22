const remote = require('./remote')
const store = require('./store')

const KEY = 'enableArtifact'

const DENY = [
  'mcp__claude_ai_Claude_Docs',
  'ShareOnboardingGuide',
  'PublishPlugin',
  'DesignSync',
  'RemoteTrigger',
]

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

function isOff(opts) {
  return remote.readSettings(opts)[KEY] === false
}

function setOff(off, opts, root) {
  const current = remote.readForWrite(opts)
  const next = { ...current }
  let changed = false

  if (off) {
    if (next[KEY] !== false) { next[KEY] = false; changed = true }
  } else if (!(opts && opts.keepKey) && Object.prototype.hasOwnProperty.call(next, KEY)) {
    delete next[KEY]
    changed = true
  }

  if (root) {
    const had = store.getArtifactsAdded(root)
    const perms = current.permissions
    const deny = isObj(perms) ? perms.deny : undefined
    const usable = (perms === undefined || isObj(perms)) && (deny === undefined || Array.isArray(deny))
    if (off && usable) {
      const missing = DENY.filter((e) => !(deny || []).includes(e))
      if (missing.length) {
        const record = {
          deny: [...((had && had.deny) || []), ...missing],
          createdDeny: (had && had.createdDeny) || deny === undefined,
          createdPermissions: (had && had.createdPermissions) || perms === undefined,
        }
        next.permissions = { ...(perms || {}), deny: [...(deny || []), ...missing] }
        changed = true
        store.setArtifactsAdded(root, record)
      }
    } else if (!off && had) {
      if (usable && Array.isArray(deny)) {
        const left = deny.filter((e) => !had.deny.includes(e))
        if (left.length !== deny.length) {
          const p = { ...perms }
          if (left.length || !had.createdDeny) p.deny = left
          else delete p.deny
          if (Object.keys(p).length || !had.createdPermissions) next.permissions = p
          else delete next.permissions
          changed = true
        }
      }
    }
  }

  if (changed) remote.writeSettings(next, opts)
  if (root && !off && store.getArtifactsAdded(root)) store.setArtifactsAdded(root, null)
  return { changed }
}

module.exports = { KEY, DENY, isOff, setOff }
