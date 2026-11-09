const fs = require('fs')

const artifacts = require('./artifacts')
const profiles = require('./profiles')
const remote = require('./remote')
const store = require('./store')
const windows = require('./windows')

const pathsOf = (opts) => (opts && opts.home ? { home: opts.home } : undefined)

function applyPreferences(root, name, opts) {
  const o = opts || {}
  const log = o.log || (() => {})
  const paths = pathsOf(o)
  const out = { remote: null, artifacts: null }
  if (!name) return out
  if (store.remoteManaged(root)) {
    const off = store.getRemote(root, name) === 'off'
    try {
      out.remote = remote.setDisabled(off, paths)
      if (out.remote.changed) log('remote control ' + (off ? 'disabled' : 'enabled') + ' for "' + name + '"')
    } catch (e) { log('remote control: ' + (e && e.message)) }
  }
  if (store.artifactsManaged(root)) {
    const off = store.getArtifacts(root, name) === 'off'
    try {
      out.artifacts = artifacts.setOff(off, paths)
      if (out.artifacts.changed) log('artifacts ' + (off ? 'turned off' : 'back on') + ' for "' + name + '"')
    } catch (e) { log('artifacts: ' + (e && e.message)) }
  }
  return out
}

function setFor(root, name, on, opts, what, save, set) {
  const o = opts || {}
  const log = o.log || (() => {})
  const paths = pathsOf(o)
  save(root, name, on ? 'on' : 'off')
  let applied = false
  let warning = null
  if (profiles.activeProfile(root, paths) === name) {
    try { applied = set(on, paths).changed } catch (e) {
      log(what + ': ' + (e && e.message))
      warning = (e && e.message) || 'it could not be changed'
    }
  }
  try {
    if (fs.existsSync(windows.windowDir(root, name)) && windows.syncSettings(root, name, paths)) applied = true
  } catch (e) { log('window settings sync: ' + (e && e.message)) }
  return { applied, warning }
}

function setRemoteFor(root, name, on, opts) {
  return setFor(root, name, on, opts, 'remote control', store.setRemote, (v, paths) => remote.setDisabled(!v, paths))
}

function setArtifactsFor(root, name, on, opts) {
  return setFor(root, name, on, opts, 'artifacts', store.setArtifacts, (v, paths) => artifacts.setOff(!v, paths))
}

module.exports = { applyPreferences, setRemoteFor, setArtifactsFor }
