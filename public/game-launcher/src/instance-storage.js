'use strict'

;(function installInstanceStorageScope(global) {
  function readQueryParameter(name) {
    var parts = global.location.search.replace(/^\?/, '').split('&')
    for (var index = 0; index < parts.length; index++) {
      var pair = parts[index].split('=')
      if (decodeURIComponent(pair[0] || '') === name) {
        return decodeURIComponent((pair.slice(1).join('=') || '').replace(/\+/g, ' '))
      }
    }
    return ''
  }

  var scope = readQueryParameter('storageScope')
  if (!/^slot-[1-4]$/.test(scope)) return

  var prefix = '__audited_game_instance__' + scope + '__'

  function scopedName(name) {
    return prefix + String(name)
  }

  function installStorageScope() {
    var prototype = global.Storage && global.Storage.prototype
    if (!prototype) return
    var originalGetItem = prototype.getItem
    var originalSetItem = prototype.setItem
    var originalRemoveItem = prototype.removeItem
    var originalKey = prototype.key
    var originalLength = Object.getOwnPropertyDescriptor(prototype, 'length')

    prototype.getItem = function (key) {
      return originalGetItem.call(this, scopedName(key))
    }
    prototype.setItem = function (key, value) {
      return originalSetItem.call(this, scopedName(key), value)
    }
    prototype.removeItem = function (key) {
      return originalRemoveItem.call(this, scopedName(key))
    }
    prototype.key = function (index) {
      var requestedIndex = Number(index)
      var visibleIndex = 0
      for (var rawIndex = 0; ; rawIndex++) {
        var rawKey = originalKey.call(this, rawIndex)
        if (rawKey == null) return null
        if (rawKey.indexOf(prefix) !== 0) continue
        if (visibleIndex === requestedIndex) return rawKey.slice(prefix.length)
        visibleIndex++
      }
    }
    prototype.clear = function () {
      var keys = []
      for (var index = 0; ; index++) {
        var rawKey = originalKey.call(this, index)
        if (rawKey == null) break
        if (rawKey.indexOf(prefix) === 0) keys.push(rawKey)
      }
      keys.forEach(function (key) {
        originalRemoveItem.call(this, key)
      }, this)
    }
    if (originalLength && typeof originalLength.get === 'function' && originalLength.configurable) {
      Object.defineProperty(prototype, 'length', {
        configurable: true,
        enumerable: originalLength.enumerable,
        get: function () {
          var count = 0
          var rawLength = originalLength.get.call(this)
          for (var index = 0; index < rawLength; index++) {
            var rawKey = originalKey.call(this, index)
            if (rawKey != null && rawKey.indexOf(prefix) === 0) count++
          }
          return count
        }
      })
    }
  }

  function installIndexedDbScope() {
    var prototype = global.IDBFactory && global.IDBFactory.prototype
    if (!prototype) return
    var originalOpen = prototype.open
    var originalDeleteDatabase = prototype.deleteDatabase
    if (typeof originalOpen === 'function') {
      prototype.open = function (name, version) {
        if (arguments.length > 1) return originalOpen.call(this, scopedName(name), version)
        return originalOpen.call(this, scopedName(name))
      }
    }
    if (typeof originalDeleteDatabase === 'function') {
      prototype.deleteDatabase = function (name) {
        return originalDeleteDatabase.call(this, scopedName(name))
      }
    }
  }

  function installCacheStorageScope() {
    var cacheStorage = global.caches
    if (!cacheStorage) return
    ;['open', 'delete', 'has'].forEach(function (methodName) {
      var original = cacheStorage[methodName]
      if (typeof original !== 'function') return
      cacheStorage[methodName] = function (name) {
        return original.call(this, scopedName(name))
      }
    })
  }

  function installBroadcastChannelScope() {
    var NativeBroadcastChannel = global.BroadcastChannel
    if (typeof NativeBroadcastChannel !== 'function') return
    var ScopedBroadcastChannel = function (name) {
      return new NativeBroadcastChannel(scopedName(name))
    }
    ScopedBroadcastChannel.prototype = NativeBroadcastChannel.prototype
    global.BroadcastChannel = ScopedBroadcastChannel
  }

  installStorageScope()
  installIndexedDbScope()
  installCacheStorageScope()
  installBroadcastChannelScope()
  global.__AUDIT_INSTANCE_STORAGE_SCOPE__ = scope
  if (global.document && global.document.documentElement) {
    global.document.documentElement.dataset.instanceStorageScope = scope
  }
  console.log('[audit] installed hosted instance storage scope:', scope)
})(window)

