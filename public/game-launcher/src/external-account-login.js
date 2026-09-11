'use strict'

// The selected assistant account is supplied by the parent, in memory only.
;(function installExternalAccountLogin(global) {
  const MAX_BIN_BYTES = 2 * 1024 * 1024
  const MAX_DECODED_BYTES = 8 * 1024 * 1024
  const parentOrigin = global.location.origin
  const slot = 1
  let credential = null
  let accepted = false
  let resolveCredential
  let rejectCredential
  const ready = new Promise((resolve, reject) => {
    resolveCredential = resolve
    rejectCredential = reject
  })
  // Authentication may not yet be waiting when validation fails.
  ready.catch(() => {})
  function safeString(value) { return value == null ? '' : String(value).slice(0, 200) }
  function post(event) {
    if (global.parent !== global) global.parent.postMessage({ type: 'audited-game-instance', slot, event }, parentOrigin)
  }
  function parseJsonBytes(bytes) {
    var text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
    var parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('BIN 内容必须是登录对象')
    }
    return parsed
  }

  function getCore() {
    if (global.o4e && typeof global.o4e.lz4XorDecode === 'function') {
      return global.o4e
    }
    if (typeof global.__require !== 'function') return null
    try {
      var namedCore = global.__require('@o4e/core')
      if (namedCore && typeof namedCore.lz4XorDecode === 'function') return namedCore
    } catch (error) {}
    try {
      var numberedCore = global.__require(13)
      return numberedCore && typeof numberedCore.lz4XorDecode === 'function'
        ? numberedCore
        : null
    } catch (error) {
      return null
    }
  }

  function getBon() {
    if (typeof global.__require !== 'function') return null
    try {
      var namedBon = global.__require('@o4e/bon')
      if (namedBon && typeof namedBon.decode === 'function') return namedBon
    } catch (error) {}
    try {
      var numberedBon = global.__require(11)
      return numberedBon && typeof numberedBon.decode === 'function' ? numberedBon : null
    } catch (error) {
      return null
    }
  }

  function waitForCore(timeoutMs) {
    return new Promise(function (resolve, reject) {
      var deadline = Date.now() + timeoutMs
      function check() {
        var core = getCore()
        if (core) {
          resolve(core)
          return
        }
        if (Date.now() >= deadline) {
          reject(new Error('游戏解码组件加载超时，请刷新页面后重试'))
          return
        }
        global.setTimeout(check, 200)
      }
      check()
    })
  }

  function readHeaderXorKey(bytes) {
    return (
      (((bytes[2] >> 6) & 1) << 7) |
      (((bytes[2] >> 4) & 1) << 6) |
      (((bytes[2] >> 2) & 1) << 5) |
      ((bytes[2] & 1) << 4) |
      (((bytes[3] >> 6) & 1) << 3) |
      (((bytes[3] >> 4) & 1) << 2) |
      (((bytes[3] >> 2) & 1) << 1) |
      (bytes[3] & 1)
    )
  }

  function decodePxPayload(bytes) {
    if (!bytes || bytes.length <= 4 || bytes[0] !== 112 || bytes[1] !== 120) {
      throw new Error('PX 文件头无效')
    }
    var decoded = bytes.slice()
    var xorKey = readHeaderXorKey(decoded)
    for (var index = decoded.length; --index >= 4; ) decoded[index] ^= xorKey
    return decoded.subarray(4)
  }

  function parseBonBytes(decoded, jsonError, plainError) {
    var bon = getBon()
    if (!bon) throw new Error('游戏 BIN 解码组件尚未就绪，请刷新页面后重试')
    try {
      var parsed = bon.decode(decoded)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('BIN 内容必须是登录对象')
      }
      return parsed
    } catch (bonError) {
      throw new Error(
        'BIN 数据格式无效：' +
          safeString(bonError.message || (jsonError && jsonError.message) || plainError.message)
      )
    }
  }

  function decodeBin(bytes) {
    try {
      return Promise.resolve(parseJsonBytes(bytes))
    } catch (plainError) {
      return waitForCore(90000).then(function (core) {
        var decoded
        try {
          decoded =
            bytes.length > 4 && bytes[0] === 112 && bytes[1] === 120
              ? decodePxPayload(bytes)
              : core.lz4XorDecode(bytes.slice())
        } catch (error) {
          throw new Error('BIN 解码失败，请确认文件来自当前版本且未损坏')
        }
        if (!decoded || decoded.byteLength > MAX_DECODED_BYTES) {
          throw new Error('BIN 解码结果超出安全限制')
        }
        try {
          return parseJsonBytes(decoded)
        } catch (jsonError) {
          return parseBonBytes(decoded, jsonError, plainError)
        }
      })
    }
  }

  function firstObject() {
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i]
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    }
    return null
  }

  function firstValue() {
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i]
      if (value !== undefined && value !== null && value !== '') return value
    }
    return null
  }

  function normalizeCredential(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('登录数据不是有效对象')
    }
    var objectData = firstObject(payload.object, payload.auth, payload.credential, payload)
    var mixData = firstObject(payload.mix, objectData && objectData.mix)
    var info = firstValue(objectData && objectData.info, payload.info, mixData && mixData.info)
    var platformExt = firstValue(
      objectData && objectData.platformExt,
      payload.platformExt,
      mixData && mixData.platformExt
    )
    var serverId = firstValue(
      objectData && objectData.serverId,
      payload.serverId,
      mixData && mixData.serverId
    )
    var serverName = firstValue(
      objectData && objectData.serverName,
      payload.serverName,
      mixData && mixData.serverName
    )
    var roleName = firstValue(
      objectData && objectData.roleName,
      payload.roleName,
      mixData && mixData.roleName
    )
    var platform = firstValue(
      objectData && objectData.platform,
      payload.platform,
      mixData && mixData.platform
    )
    if (info == null) throw new Error('登录数据缺少 info')
    if (platformExt == null) throw new Error('登录数据缺少 platformExt')
    if (typeof info !== 'string') {
      try {
        info = JSON.stringify(info)
      } catch (error) {
        throw new Error('登录 info 无法转换为 JSON 字符串')
      }
    }
    if (!info || info.length > MAX_DECODED_BYTES) throw new Error('登录 info 长度无效')
    return {
      info: info,
      platformExt: safeString(platformExt),
      platform: platform == null ? null : safeString(platform),
      serverId: serverId == null ? null : safeString(serverId),
      serverName: serverName == null ? null : safeString(serverName),
      roleName: roleName == null ? null : safeString(roleName)
    }
  }

  function patchRequest(request) {
    if (!credential || !request || typeof request !== 'object') return request
    var patched = Object.assign({}, request, {
      info: credential.info,
      platformExt: credential.platformExt
    })
    if (credential.platform != null) patched.platform = credential.platform
    if (credential.serverId != null) patched.serverId = credential.serverId
    return patched
  }

  function getLoginService() {
    if (typeof global.__require !== 'function') return null
    try {
      var dataIndex = global.__require('data-index')
      return dataIndex && dataIndex.LoginService
    } catch (error) {
      return null
    }
  }

  function installHooks() {
    const service = getLoginService()
    if (!service || typeof service.authUser !== 'function') return false
    if (service.authUser.__externalAccountLogin) return true
    const original = service.authUser
    service.authUser = function(request) {
      return ready.then(() => {
        post('account-login-started')
        return original.call(this, patchRequest(request))
      }).then(response => {
        post(response && !response.code ? 'account-login-success' : 'account-login-failed')
        return response
      }).catch(error => {
        post('account-login-failed')
        throw error
      })
    }
    service.authUser.__externalAccountLogin = true
    return true
  }
  global.addEventListener('message', event => {
    if (global.parent === global || event.source !== global.parent || event.origin !== parentOrigin) return
    if (event.data?.type !== 'xyzw-game-account' || accepted) return
    const bytes = event.data.bin
    if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > MAX_BIN_BYTES) {
      post('account-data-invalid')
      return
    }
    accepted = true
    decodeBin(new Uint8Array(bytes)).then(payload => {
      credential = normalizeCredential(payload)
      resolveCredential()
    }).catch(() => {
      post('account-data-invalid')
      rejectCredential(new Error('登录数据无效，请在账号管理中重新导入'))
    })
  })
  global.AuditedAccountLogin = Object.freeze({ installHooks })
  post('account-bridge-ready')
})(window)

