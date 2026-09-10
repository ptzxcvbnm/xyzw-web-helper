'use strict';

// Minimal, readable replacements for the platform objects that the launcher
// expects in a browser. This file intentionally provides no account import,
// payment, clipboard reads, cookie, or arbitrary userscript capabilities.
(function installPlatformCompatibility(global) {
  var MAX_CLIPBOARD_TEXT_LENGTH = 32768

  function callClipboardCallback(callback, value) {
    if (typeof callback !== 'function') return
    global.setTimeout(function () {
      try {
        callback(value)
      } catch (error) {
        console.warn('[audit] clipboard callback failed')
      }
    }, 0)
  }

  function hasClipboardUserActivation() {
    var userActivation = global.navigator && global.navigator.userActivation
    return (
      !userActivation ||
      userActivation.isActive === true ||
      userActivation.hasBeenActive === true
    )
  }

  function copyWithDocumentCommand(text) {
    if (
      !global.document ||
      !global.document.body ||
      typeof global.document.execCommand !== 'function'
    ) {
      return false
    }

    var activeElement = global.document.activeElement
    var textarea = global.document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.setAttribute('aria-hidden', 'true')
    textarea.style.position = 'fixed'
    textarea.style.left = '-10000px'
    textarea.style.top = '0'
    global.document.body.appendChild(textarea)
    textarea.select()

    var copied = false
    try {
      copied = global.document.execCommand('copy') === true
    } catch (error) {
      copied = false
    }

    global.document.body.removeChild(textarea)
    if (activeElement && typeof activeElement.focus === 'function') {
      try {
        activeElement.focus()
      } catch (error) {}
    }
    return copied
  }

  function normalizeClipboardText(value) {
    var candidate = value
    if (
      value &&
      typeof value === 'object' &&
      Object.prototype.hasOwnProperty.call(value, 'text')
    ) {
      candidate = value.text
    }
    if (typeof candidate === 'string') return candidate
    if (typeof candidate === 'number' && isFinite(candidate)) return String(candidate)
    return null
  }

  function describeClipboardValue(value) {
    var type = value === null ? 'null' : typeof value
    if (!value || typeof value !== 'object') return type
    var keys = []
    try {
      keys = Object.keys(value).slice(0, 8)
    } catch (error) {}
    return type + (Array.isArray(value) ? ':array' : '') + ':keys=' + keys.join(',')
  }

  function writeClipboardText(value) {
    var text = normalizeClipboardText(value)
    if (text === null || text.length > MAX_CLIPBOARD_TEXT_LENGTH) {
      console.warn(
        '[audit] blocked invalid clipboard write ' + describeClipboardValue(value)
      )
      return global.Promise.resolve(false)
    }
    if (!hasClipboardUserActivation()) {
      console.warn('[audit] blocked clipboard write without user activation')
      return global.Promise.resolve(false)
    }

    if (copyWithDocumentCommand(text)) {
      return global.Promise.resolve(true)
    }

    var clipboard = global.navigator && global.navigator.clipboard
    if (clipboard && typeof clipboard.writeText === 'function') {
      return global.Promise.resolve()
        .then(function () {
          return clipboard.writeText(text)
        })
        .then(function () {
          return true
        })
        .catch(function () {
          return false
        })
    }

    return global.Promise.resolve(false)
  }

  function setClipboard(value, callback) {
    return writeClipboardText(value).then(function (copied) {
      if (copied) {
        console.log('[audit] clipboard write completed')
      } else {
        console.warn('[audit] clipboard write failed')
      }
      callClipboardCallback(callback, copied)
      return copied
    })
  }

  function setClipboardData(options) {
    var request = options && typeof options === 'object' ? options : {}
    return writeClipboardText(request.data).then(function (copied) {
      var result = copied
        ? { errMsg: 'setClipboardData:ok' }
        : { errMsg: 'setClipboardData:fail' }
      callClipboardCallback(copied ? request.success : request.fail, result)
      callClipboardCallback(request.complete, result)
      return copied
    })
  }

  function createMemoryCacheManager() {
    var entries = Object.create(null)
    var cachedFiles = {
      _map: entries,
      add: function (key, value) {
        entries[key] = value
        return value
      },
      get: function (key) {
        return entries[key]
      },
      has: function (key) {
        return Object.prototype.hasOwnProperty.call(entries, key)
      },
      remove: function (key) {
        var value = entries[key]
        delete entries[key]
        return value
      },
      clear: function () {
        Object.keys(entries).forEach(function (key) {
          delete entries[key]
        })
      }
    }

    return {
      cachedFiles: cachedFiles,
      getCache: function (key) {
        var entry = cachedFiles.get(key)
        if (typeof entry === 'string') return entry
        return entry && (entry.url || entry.path) || null
      },
      removeCache: function (key) {
        cachedFiles.remove(key)
      },
      clearCache: function () {
        cachedFiles.clear()
      }
    }
  }

  if (!global.wx) {
    global.wx = {
      getSystemInfo: function () {},
      getStorageInfo: function () {},
      onShow: function (callback) {
        if (typeof callback === 'function') {
          setTimeout(function () {
            callback({ scene: '0', query: {}, shareTicket: [] })
          }, 0)
        }
      },
      onHide: function () {},
      setClipboardData: setClipboardData
    }
  }

  if (!global.HSDK) {
    global.HSDK = {
      onLogin: function (data) {
        if (data && typeof data.listener === 'function') {
          setTimeout(function () {
            data.listener({ userSdk: { isNewUser: false } })
          }, 0)
        }
      },
      reportLoginState: function () {},
      onAddictionQuit: function () {},
      getGsSetting: function () {
        return {}
      },
      setClipboard: setClipboard
    }
  } else if (typeof global.HSDK.setClipboard !== 'function') {
    global.HSDK.setClipboard = setClipboard
  }

  if (!global.__HORTOR_SDK__) {
    global.__HORTOR_SDK__ = { tga: { track: function () {} } }
  }

  global.AuditedClipboard = Object.freeze({
    setClipboard: setClipboard
  })

  // Small CommonJS-style bridge used by one launcher SDK. Unlike the original
  // patch, this does not compile or execute strings dynamically.
  if (!global.define) {
    global.define = function (name, factory) {
      var module = { exports: {} }
      var requireModule = global.require || function () { return {} }
      if (typeof factory === 'function') {
        factory(requireModule, module, module.exports)
      }
      return module.exports
    }
  }

  global.installAuditedCocosGuards = function () {
    if (!global.cc || !global.cc.assetManager) return

    // Cocos 2.4.9 leaves cacheManager null on Web, while its parser and the
    // recovered launcher still dereference cachedFiles. Use a memory-only
    // implementation; browser HTTP caching remains controlled by fetch/XHR.
    if (!global.cc.assetManager.cacheManager) {
      global.cc.assetManager.cacheManager = createMemoryCacheManager()
      console.log('[audit] installed memory-only Web cacheManager')
    }

    ;['loadAny', 'loadBundle'].forEach(function (methodName) {
      var original = global.cc.assetManager[methodName]
      if (typeof original !== 'function') return

      Object.defineProperty(global.cc.assetManager, methodName, {
        configurable: true,
        enumerable: true,
        get: function () {
          return original
        },
        set: function (next) {
          var compact = typeof next === 'function' ? next.toString().replace(/\s/g, '') : ''
          if (compact === 'function(){}') {
            console.warn('[audit] blocked replacement of cc.assetManager.' + methodName + ' with an empty function')
            return
          }
          original = next
        }
      })
    })
  }
})(window)

