'use strict';

(function installAuditTrace(global) {
  var consoleObject = global.console
  if (!consoleObject || consoleObject.__auditTraceInstalled) return

  var accepted = /\[Game\]|authUser|LoadConfig|GameLogin|SwitchRole|state|config|manifest|scene|failed|error|spf/i
  var entries = []
  var methods = ['log', 'warn', 'error', 'info']

  function safeText(value) {
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (value instanceof Error) return value.message || value.name || 'Error'
    return '[object]'
  }

  methods.forEach(function (method) {
    var original = consoleObject[method]
    if (typeof original !== 'function') return

    consoleObject[method] = function () {
      var args = Array.prototype.slice.call(arguments)
      var line = args.map(safeText).join(' ').slice(0, 500)
      if (accepted.test(line)) {
        entries.push({ level: method, text: line, time: Date.now() })
        if (entries.length > 200) entries.shift()
        var status = document.getElementById('audit-status')
        if (status) {
          status.dataset.lastTrace = line
          status.dataset.trace = entries
            .slice(-80)
            .map(function (entry) { return entry.level + ': ' + entry.text })
            .join('\n')
        }
      }
      return original.apply(consoleObject, args)
    }
  })

  Object.defineProperty(consoleObject, '__auditTraceInstalled', { value: true })
  global.__AUDIT_TRACE__ = entries
})(window)

