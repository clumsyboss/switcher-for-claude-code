const remote = require('./remote')

const KEY = 'enableArtifact'

function isOff(opts) {
  return remote.readSettings(opts)[KEY] === false
}

function setOff(off, opts) {
  return remote.setKey(KEY, off ? false : undefined, opts)
}

module.exports = { KEY, isOff, setOff }
