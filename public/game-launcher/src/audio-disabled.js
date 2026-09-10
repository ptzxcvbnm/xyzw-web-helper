'use strict'

;(function disableWebAudio(global) {
  var documentObject = global.document

  function resolvedPromise(value) {
    return global.Promise && typeof global.Promise.resolve === 'function'
      ? global.Promise.resolve(value)
      : value
  }

  function settledPromise(value) {
    var promise = resolvedPromise(value)
    if (!promise || typeof promise.then !== 'function') return promise
    return promise.then(
      function () {},
      function () {}
    )
  }

  function isAudioElement(element) {
    return Boolean(element && String(element.tagName || '').toLowerCase() === 'audio')
  }

  function silenceMediaElement(element) {
    if (!element) return
    try {
      element.defaultMuted = true
      element.muted = true
      element.volume = 0
      element.removeAttribute('autoplay')
    } catch (error) {}
  }

  function silenceAttachedMedia(root) {
    if (!root) return
    if (root.nodeType === 1 && /^(?:audio|video)$/i.test(root.tagName || '')) {
      silenceMediaElement(root)
    }
    if (typeof root.querySelectorAll !== 'function') return
    var media = root.querySelectorAll('audio, video')
    Array.prototype.forEach.call(media, silenceMediaElement)
  }

  function installMediaGuard() {
    var mediaPrototype = global.HTMLMediaElement && global.HTMLMediaElement.prototype
    if (!mediaPrototype || typeof mediaPrototype.play !== 'function') return
    if (mediaPrototype.__auditedAudioDisabled) return

    var originalPlay = mediaPrototype.play
    try {
      mediaPrototype.play = function () {
        silenceMediaElement(this)
        if (isAudioElement(this)) {
          try {
            if (typeof this.pause === 'function') this.pause()
          } catch (error) {}
          return resolvedPromise()
        }
        return originalPlay.apply(this, arguments)
      }
      Object.defineProperty(mediaPrototype, '__auditedAudioDisabled', {
        configurable: false,
        value: true
      })
    } catch (error) {
      console.warn('[audit] permanent HTML audio guard could not be installed')
    }

    if (typeof global.Audio === 'function') {
      var NativeAudio = global.Audio
      var DisabledAudio = function (source) {
        var element = arguments.length ? new NativeAudio(source) : new NativeAudio()
        silenceMediaElement(element)
        return element
      }
      DisabledAudio.prototype = NativeAudio.prototype
      try {
        global.Audio = DisabledAudio
      } catch (error) {
        console.warn('[audit] Audio constructor could not be guarded')
      }
    }
  }

  function installAudioContextGuard(name) {
    var NativeAudioContext = global[name]
    if (typeof NativeAudioContext !== 'function') return

    var contextPrototype = NativeAudioContext.prototype
    var originalSuspend = contextPrototype && contextPrototype.suspend
    if (contextPrototype && !contextPrototype.__auditedAudioDisabled) {
      try {
        contextPrototype.resume = function () {
          if (typeof originalSuspend !== 'function') return resolvedPromise()
          try {
            return settledPromise(originalSuspend.call(this))
          } catch (error) {
            return resolvedPromise()
          }
        }
        Object.defineProperty(contextPrototype, '__auditedAudioDisabled', {
          configurable: false,
          value: true
        })
      } catch (error) {
        console.warn('[audit] Web Audio resume guard could not be installed')
      }
    }

    var DisabledAudioContext = function (options) {
      var context = arguments.length
        ? new NativeAudioContext(options)
        : new NativeAudioContext()
      if (typeof originalSuspend === 'function') {
        try {
          settledPromise(originalSuspend.call(context))
        } catch (error) {}
      }
      return context
    }
    DisabledAudioContext.prototype = NativeAudioContext.prototype
    try {
      global[name] = DisabledAudioContext
    } catch (error) {
      console.warn('[audit] Web Audio constructor could not be guarded')
    }
  }

  function disabledPlay() {
    return -1
  }

  function disabledResume() {
    return false
  }

  function lockCocosPlayback(audioEngine) {
    if (!audioEngine) return
    try {
      if (typeof audioEngine.play === 'function') audioEngine.play = disabledPlay
      if (typeof audioEngine.playMusic === 'function') audioEngine.playMusic = disabledPlay
      if (typeof audioEngine.playEffect === 'function') audioEngine.playEffect = disabledPlay
      if (typeof audioEngine.resume === 'function') audioEngine.resume = disabledResume
      if (typeof audioEngine.resumeAll === 'function') audioEngine.resumeAll = disabledResume
      audioEngine.__auditedPlaybackDisabled = true
      if (documentObject && documentObject.documentElement) {
        documentObject.documentElement.dataset.cocosAudioMode = 'disabled'
      }
    } catch (error) {
      console.warn('[audit] Cocos playback methods could not be disabled')
    }
  }

  function enforceDisabledAudio() {
    silenceAttachedMedia(documentObject)
    var audioEngine = global.cc && global.cc.audioEngine
    if (!audioEngine) return
    try {
      if (typeof audioEngine.stopAll === 'function') audioEngine.stopAll()
      if (typeof audioEngine.setMusicVolume === 'function') audioEngine.setMusicVolume(0)
      if (typeof audioEngine.setEffectsVolume === 'function') audioEngine.setEffectsVolume(0)
      lockCocosPlayback(audioEngine)
    } catch (error) {
      console.warn('[audit] permanent Cocos audio disable could not be enforced')
    }
  }

  installMediaGuard()
  installAudioContextGuard('AudioContext')
  if (global.webkitAudioContext !== global.AudioContext) {
    installAudioContextGuard('webkitAudioContext')
  }

  if (documentObject) {
    documentObject.documentElement.dataset.audioMode = 'disabled'
    documentObject.addEventListener('play', function (event) {
      var element = event.target
      silenceMediaElement(element)
      if (isAudioElement(element) && typeof element.pause === 'function') element.pause()
    }, true)
    silenceAttachedMedia(documentObject)
    if (typeof global.MutationObserver === 'function') {
      var observer = new global.MutationObserver(function (records) {
        records.forEach(function (record) {
          Array.prototype.forEach.call(record.addedNodes || [], silenceAttachedMedia)
        })
      })
      observer.observe(documentObject.documentElement, { childList: true, subtree: true })
    }
  }

  global.AuditedAudioDisabled = Object.freeze({
    enforce: enforceDisabledAudio,
    isDisabled: true
  })
  global.setInterval(enforceDisabledAudio, 400)
  console.log('[audit] all webpage audio is permanently disabled')
})(window)

