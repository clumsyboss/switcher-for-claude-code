const fs = require('fs')
const os = require('os')
const path = require('path')

const KEY = 'disableRemoteControl'

function settingsPath(opts) {
  const home = (opts && opts.home) || os.homedir()
  return path.join(home, '.claude', 'settings.json')
}

function readSettings(opts) {
  try {
    const raw = fs.readFileSync(settingsPath(opts), 'utf8')
    const j = JSON.parse(raw)
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

function isDisabled(opts) {
  return readSettings(opts)[KEY] === true
}

function readForWrite(opts) {
  let raw
  try { raw = fs.readFileSync(settingsPath(opts), 'utf8') } catch { return {} }
  let j
  try { j = JSON.parse(raw.replace(/^﻿/, '')) } catch { j = null }
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    throw new Error(settingsPath(opts) + ' is not valid JSON, so it was left unchanged')
  }
  return j
}

function writeSettings(next, opts) {
  const file = settingsPath(opts)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

function setDisabled(disabled, opts) {
  const current = readForWrite(opts)
  const wanted = disabled === true

  if (wanted === (current[KEY] === true)) return { changed: false, disabled: wanted }

  const next = { ...current }
  if (wanted) next[KEY] = true
  else delete next[KEY]
  writeSettings(next, opts)
  return { changed: true, disabled: wanted }
}

function setKey(key, value, opts) {
  const current = readForWrite(opts)
  const has = Object.prototype.hasOwnProperty.call(current, key)
  if (value === undefined ? !has : (has && current[key] === value)) return { changed: false }
  const next = { ...current }
  if (value === undefined) delete next[key]
  else next[key] = value
  writeSettings(next, opts)
  return { changed: true }
}

module.exports = { KEY, settingsPath, readSettings, isDisabled, setDisabled, setKey }
