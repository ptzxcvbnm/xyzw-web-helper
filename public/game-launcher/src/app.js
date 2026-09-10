'use strict';

(function startAuditedLauncher(global) {
  var status = document.getElementById('audit-status')
  var canvas = document.getElementById('GameCanvas')
  var roleSwitchRecoveryKey = 'audit-role-switch-recovery'

  if (canvas) {
    canvas.addEventListener('contextmenu', function (event) {
      event.preventDefault()
    })
  }

  function setStatus(message, isError) {
    if (!status) return
    status.textContent = message
    status.classList.toggle('is-error', Boolean(isError))
    status.hidden = false
  }

  function describeFailure(error) {
    if (error == null) return 'unknown error'
    if (typeof error === 'string') return error
    if (error.message) return String(error.message)

    var fields = ['code', 'errCode', 'status', 'statusCode', 'msg', 'errMsg', 'error', 'reason']
    var details = []
    fields.forEach(function (field) {
      var value = error[field]
      if (value == null || typeof value === 'object') return
      details.push(field + '=' + String(value))
    })

    if (details.length) return details.join(', ')

    var keys = typeof error === 'object' ? Object.keys(error).slice(0, 20) : []
    return keys.length
      ? 'object keys=' + keys.join('|')
      : Object.prototype.toString.call(error)
  }

  function reportFailure(error) {
    var message = describeFailure(error)

    if (message.indexOf('finalBlockRateLimit') >= 0) {
      try {
        if (!global.sessionStorage.getItem(roleSwitchRecoveryKey)) {
          global.sessionStorage.setItem(roleSwitchRecoveryKey, '1')
          global.location.reload()
          return
        }
      } catch (storageError) {
        console.warn('[audit] role-switch recovery marker is unavailable')
      }
    }

    global.__AUDIT_LAST_ERROR__ = {
      message: message,
      name: error && error.name ? String(error.name) : '',
      stack: error && error.stack ? String(error.stack) : '',
      keys: error && typeof error === 'object' ? Object.keys(error).slice(0, 20) : []
    }
    console.error('[audit] startup failed', error)
    setStatus('启动失败：' + message, true)
  }

  function isOptionalRuntimeFailure(error) {
    return Boolean(error && error.errMsg === 'load spf failed')
  }

  global.addEventListener('error', function (event) {
    reportFailure(event.error || event.message)
  })
  global.addEventListener('unhandledrejection', function (event) {
    if (isOptionalRuntimeFailure(event.reason)) {
      console.warn('[audit] optional HSDK survey image failed to preload')
      return
    }
    reportFailure(event.reason)
  })

  global.HtmlIsLoaded = true

  if (!global.__AUDIT_RUNTIME_CONFIG__) {
    reportFailure(new Error('runtime config is missing'))
    return
  }
  if (!global.cc || typeof global.boot !== 'function') {
    reportFailure(new Error('Cocos runtime or boot function is missing'))
    return
  }

  if (typeof global.installAuditedCocosGuards === 'function') {
    global.installAuditedCocosGuards()
  }
  if (global.AuditedAudioDisabled && typeof global.AuditedAudioDisabled.enforce === 'function') {
    global.AuditedAudioDisabled.enforce()
  }

  setStatus('正在获取资源清单…', false)
  Promise.resolve(global.boot())
    .then(function () {
      var splash = document.getElementById('splash')
      if (splash) splash.style.display = 'none'
      try {
        global.sessionStorage.removeItem(roleSwitchRecoveryKey)
      } catch (storageError) {}
      setStatus('启动流程已交给 Cocos', false)
      setTimeout(function () {
        if (status && !status.classList.contains('is-error')) status.hidden = true
      }, 1800)
    })
    .catch(reportFailure)
})(window)

