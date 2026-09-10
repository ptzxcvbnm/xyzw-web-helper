'use strict'

;(function installInstanceBridge(global) {
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

  var slot = Number(readQueryParameter('slot'))
  var parentOrigin = readQueryParameter('parentOrigin')
  var MUTE_ENFORCEMENT_INTERVAL_MS = 400
  var muted = true
  var audioMuteApplied = false
  var previousMusicVolume = 1
  var previousEffectsVolume = 1
  var mediaStates = []
  var suspendedContexts = []
  var contextSuspendPending = false

  if (
    typeof slot !== 'number' ||
    !isFinite(slot) ||
    Math.floor(slot) !== slot ||
    slot < 1 ||
    slot > 4 ||
    !/^https?:\/\/[^/]+$/.test(parentOrigin)
  ) {
    return
  }

  function post(event, details) {
    var payload = {
      type: 'audited-game-instance',
      event: event,
      slot: slot
    }
    if (details && typeof details === 'object') {
      Object.keys(details).forEach(function (key) {
        payload[key] = details[key]
      })
    }
    global.parent.postMessage(payload, parentOrigin)
  }

  function findMediaState(element) {
    for (var index = 0; index < mediaStates.length; index++) {
      if (mediaStates[index].element === element) return mediaStates[index]
    }
    return null
  }

  function muteMediaElement(element) {
    if (!element) return
    var state = findMediaState(element)
    if (!state) {
      state = {
        element: element,
        muted: element.muted === true,
        volume: typeof element.volume === 'number' ? element.volume : 1
      }
      mediaStates.push(state)
    }
    try {
      element.muted = true
      element.volume = 0
    } catch (error) {}
  }

  function muteAttachedMedia() {
    var media = document.querySelectorAll('audio, video')
    Array.prototype.forEach.call(media, muteMediaElement)
  }

  function restoreMediaElements() {
    mediaStates.forEach(function (state) {
      try {
        state.element.muted = state.muted
        state.element.volume = state.volume
      } catch (error) {}
    })
    mediaStates = []
  }

  function getCocosAudioContext() {
    return global.cc &&
      global.cc.sys &&
      global.cc.sys.__audioSupport &&
      global.cc.sys.__audioSupport.context
  }

  function rememberSuspendedContext(context) {
    if (suspendedContexts.indexOf(context) < 0) suspendedContexts.push(context)
  }

  function suspendCocosAudioContext() {
    var context = getCocosAudioContext()
    if (
      !context ||
      context.state !== 'running' ||
      typeof context.suspend !== 'function' ||
      contextSuspendPending
    ) {
      return
    }
    contextSuspendPending = true
    global.Promise.resolve(context.suspend()).then(
      function () {
        rememberSuspendedContext(context)
        if (!muted && typeof context.resume === 'function') {
          return context.resume()
        }
      },
      function () {
        console.warn('[audit] instance audio context could not be suspended')
      }
    ).then(
      function () {
        contextSuspendPending = false
      },
      function () {
        contextSuspendPending = false
      }
    )
  }

  function resumeSuspendedContexts() {
    var contexts = suspendedContexts.slice()
    suspendedContexts = []
    contexts.forEach(function (context) {
      if (context.state !== 'suspended' || typeof context.resume !== 'function') return
      global.Promise.resolve(context.resume()).catch(function () {
        console.warn('[audit] instance audio context could not be resumed')
      })
    })
  }

  function setMuteDiagnostics() {
    var context = getCocosAudioContext()
    document.documentElement.dataset.instanceMuted = muted ? 'true' : 'false'
    document.documentElement.dataset.instanceAudioContext = context && context.state
      ? String(context.state)
      : 'unavailable'
  }

  function enforceMute() {
    if (!muted) return
    var audioEngine = global.cc && global.cc.audioEngine
    try {
      if (audioEngine && !audioMuteApplied) {
        if (typeof audioEngine.getMusicVolume === 'function') {
          previousMusicVolume = audioEngine.getMusicVolume()
        }
        if (typeof audioEngine.getEffectsVolume === 'function') {
          previousEffectsVolume = audioEngine.getEffectsVolume()
        }
        audioMuteApplied = true
      }
      if (audioEngine && typeof audioEngine.setMusicVolume === 'function') {
        audioEngine.setMusicVolume(0)
      }
      if (audioEngine && typeof audioEngine.setEffectsVolume === 'function') {
        audioEngine.setEffectsVolume(0)
      }
    } catch (error) {
      console.warn('[audit] instance Cocos audio volume could not be enforced')
    }
    muteAttachedMedia()
    suspendCocosAudioContext()
    setMuteDiagnostics()
  }

  function installMediaPlayGuard() {
    var mediaPrototype = global.HTMLMediaElement && global.HTMLMediaElement.prototype
    if (!mediaPrototype || typeof mediaPrototype.play !== 'function') return
    var originalPlay = mediaPrototype.play
    try {
      mediaPrototype.play = function () {
        if (muted) muteMediaElement(this)
        return originalPlay.apply(this, arguments)
      }
    } catch (error) {
      console.warn('[audit] HTML media play guard could not be installed')
    }
  }

  function applyMute(nextMuted) {
    var audioEngine = global.cc && global.cc.audioEngine
    var shouldMute = true
    if (!audioEngine) {
      muted = shouldMute
      audioMuteApplied = false
      if (muted) enforceMute()
      else {
        restoreMediaElements()
        resumeSuspendedContexts()
        setMuteDiagnostics()
      }
      post('mute-changed', { muted: muted })
      return
    }

    try {
      if (shouldMute) {
        if (!audioMuteApplied) {
          if (typeof audioEngine.getMusicVolume === 'function') {
            previousMusicVolume = audioEngine.getMusicVolume()
          }
          if (typeof audioEngine.getEffectsVolume === 'function') {
            previousEffectsVolume = audioEngine.getEffectsVolume()
          }
        }
        if (typeof audioEngine.setMusicVolume === 'function') audioEngine.setMusicVolume(0)
        if (typeof audioEngine.setEffectsVolume === 'function') audioEngine.setEffectsVolume(0)
        audioMuteApplied = true
      } else if (audioMuteApplied) {
        if (typeof audioEngine.setMusicVolume === 'function') {
          audioEngine.setMusicVolume(previousMusicVolume)
        }
        if (typeof audioEngine.setEffectsVolume === 'function') {
          audioEngine.setEffectsVolume(previousEffectsVolume)
        }
        audioMuteApplied = false
      }
    } catch (error) {
      console.warn('[audit] instance audio state could not be changed')
    }
    muted = shouldMute
    if (muted) enforceMute()
    else {
      restoreMediaElements()
      resumeSuspendedContexts()
      setMuteDiagnostics()
    }
    post('mute-changed', { muted: muted })
  }

  function reportBootStage(stage) {
    if (stage === 'scene:running') {
      applyMute(muted)
      post('scene-running')
    }
    if (typeof stage === 'string' && stage.indexOf('failed:') === 0) post('boot-failed')
  }

  global.addEventListener('message', function (event) {
    if (event.source !== global.parent || event.origin !== parentOrigin) return
    var data = event.data
    if (!data || data.type !== 'audited-instance-command') return
    if (data.command === 'mute') applyMute(data.value === true)
  })

  var status = document.getElementById('audit-status')
  if (status && typeof global.MutationObserver === 'function') {
    var observer = new global.MutationObserver(function () {
      reportBootStage(status.dataset.bootStage || '')
      if (status.classList.contains('is-error')) post('boot-failed')
    })
    observer.observe(status, {
      attributes: true,
      attributeFilter: ['class', 'data-boot-stage']
    })
  }

  global.AuditedGameInstance = Object.freeze({
    slot: slot,
    reportBootStage: reportBootStage
  })
  installMediaPlayGuard()
  global.setInterval(enforceMute, MUTE_ENFORCEMENT_INTERVAL_MS)
  setMuteDiagnostics()
  post('bridge-ready')
})(window)

