function invoke(bin, args) {
  const tail = args && args.length ? ' ' + args.join(' ') : ''
  if (process.platform === 'win32') {
    return '& ' + "'" + bin.split("'").join("''") + "'" + tail
  }
  return "'" + bin.split("'").join("'\\''") + "'" + tail
}

module.exports = { invoke }
