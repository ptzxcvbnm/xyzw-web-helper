'use strict'

;(function installPacketObserver(global) {
  var NativeWebSocket = global.WebSocket
  if (typeof NativeWebSocket !== 'function' || NativeWebSocket.__xyzwPacketObserver) return

  var MAX_PACKET_BYTES = 2 * 1024 * 1024
  var sockets = new WeakMap()
  var nextConnectionId = 0

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
  var enabled = readQueryParameter('packetObserver') === '1'

  if (
    !Number.isFinite(slot) ||
    Math.floor(slot) !== slot ||
    slot < 1 ||
    slot > 4 ||
    !/^https?:\/\/[^/]+$/.test(parentOrigin)
  ) {
    return
  }

  function post(event, details) {
    if (global.parent === global) return
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

  function getSafeTarget(url) {
    try {
      var parsed = new global.URL(String(url), global.location.href)
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null
      if (parsed.hostname !== 'hortorgames.com' && !parsed.hostname.endsWith('.hortorgames.com')) {
        return null
      }
      return parsed.protocol + '//' + parsed.host + parsed.pathname
    } catch (error) {
      return null
    }
  }

  function byteLengthOf(data) {
    if (data instanceof global.ArrayBuffer) return data.byteLength
    if (global.ArrayBuffer.isView(data)) return data.byteLength
    if (typeof global.Blob === 'function' && data instanceof global.Blob) return data.size
    if (typeof data === 'string') return data.length
    return 0
  }

  function copyArrayBuffer(data) {
    if (data instanceof global.ArrayBuffer) return data.slice(0)
    if (global.ArrayBuffer.isView(data)) {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    }
    return null
  }

  function reportFrame(socket, direction, data) {
    if (!enabled) return
    var state = sockets.get(socket)
    if (!state) return

    var frameId = ++state.frameId
    var capturedAt = Date.now()
    var byteLength = byteLengthOf(data)
    var base = {
      direction: direction,
      connectionId: state.id,
      frameId: frameId,
      capturedAt: capturedAt,
      target: state.target,
      byteLength: byteLength
    }

    if (byteLength > MAX_PACKET_BYTES) {
      post('packet-observer-frame', Object.assign(base, {
        kind: 'omitted',
        error: '报文超过 2 MB，已跳过内容'
      }))
      return
    }

    if (typeof data === 'string') {
      post('packet-observer-frame', Object.assign(base, { kind: 'text', payload: data }))
      return
    }

    var copied = copyArrayBuffer(data)
    if (copied) {
      post('packet-observer-frame', Object.assign(base, { kind: 'binary', payload: copied }))
      return
    }

    if (typeof global.Blob === 'function' && data instanceof global.Blob) {
      data.arrayBuffer().then(function (buffer) {
        post('packet-observer-frame', Object.assign(base, { kind: 'binary', payload: buffer }))
      }).catch(function () {
        post('packet-observer-frame', Object.assign(base, {
          kind: 'unreadable',
          error: 'Blob 报文读取失败'
        }))
      })
      return
    }

    post('packet-observer-frame', Object.assign(base, {
      kind: 'unsupported',
      error: '不支持的 WebSocket 报文类型'
    }))
  }

  function watchSocket(socket, url) {
    var target = getSafeTarget(url)
    if (!target) return
    var state = { id: ++nextConnectionId, frameId: 0, target: target }
    sockets.set(socket, state)
    socket.addEventListener('message', function (event) {
      reportFrame(socket, 'receive', event.data)
    })
    socket.addEventListener('open', function () {
      if (enabled) post('packet-observer-connection', {
        connectionId: state.id,
        state: 'open',
        target: state.target
      })
    })
    socket.addEventListener('close', function (event) {
      if (enabled) post('packet-observer-connection', {
        connectionId: state.id,
        state: 'closed',
        target: state.target,
        code: event.code
      })
    })
  }

  function ObservedWebSocket(url, protocols) {
    var socket = arguments.length > 1
      ? new NativeWebSocket(url, protocols)
      : new NativeWebSocket(url)
    watchSocket(socket, url)
    return socket
  }

  ObservedWebSocket.prototype = NativeWebSocket.prototype
  try { Object.setPrototypeOf(ObservedWebSocket, NativeWebSocket) } catch (error) {}
  Object.defineProperty(ObservedWebSocket, '__xyzwPacketObserver', { value: true })

  var nativeSend = NativeWebSocket.prototype.send
  NativeWebSocket.prototype.send = function () {
    reportFrame(this, 'send', arguments[0])
    return nativeSend.apply(this, arguments)
  }

  global.addEventListener('message', function (event) {
    if (event.source !== global.parent || event.origin !== parentOrigin) return
    var data = event.data
    if (!data || data.type !== 'audited-instance-command') return
    if (data.command !== 'packet-observer') return
    enabled = data.value === true
    post('packet-observer-state', { enabled: enabled })
  })

  global.WebSocket = ObservedWebSocket
  post('packet-observer-ready', { enabled: enabled })
})(window)
