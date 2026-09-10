'use strict'

;(function installAuditedAccountLogin(global) {
  var MAX_BIN_BYTES = 2 * 1024 * 1024
  var MAX_DECODED_BYTES = 8 * 1024 * 1024
  var MAX_STORED_BIN_BASE64 = Math.ceil(MAX_BIN_BYTES / 3) * 4 + 4
  var MAX_STORED_BINS = 30
  var SUB_ROLE_INTERVAL = 1000000
  var STORAGE_KEY = 'audited-account-login-v1'
  var BUTTON_POSITION_KEY = 'audited-account-login-button-position-v1'
  var BUTTON_DRAG_THRESHOLD = 5
  var credential = null
  var credentialSource = ''
  var storedBins = []
  var selectedBinId = ''
  var qrProvider = null
  var qrSession = null
  var qrTimer = 0
  var hookedService = null
  var lastServerListResponse = null
  var lastServerListCredential = null
  var rawServerListService = null
  var rawServerList = null
  var pendingQrAccountName = ''
  var awaitingServerSelection = false
  var serverDiscoveryTimer = 0
  var currentRoleOptions = []
  var directServerListRequests = 0
  var panel
  var statusNode
  var fileInput
  var binSummary
  var binListNode
  var clearBinsButton
  var qrImage
  var qrPlaceholder
  var qrStartButton
  var qrCancelButton
  var serverPicker
  var serverSelect
  var serverConfirmButton

  function setStatus(message, state) {
    if (!statusNode) return
    statusNode.textContent = message
    statusNode.className = 'account-login-status' + (state ? ' is-' + state : '')
  }

  function safeString(value) {
    return value == null ? '' : String(value).slice(0, 200)
  }

  function normalizeStoredBinBase64(value) {
    if (value == null || value === '') return ''
    if (
      typeof value !== 'string' ||
      value.length > MAX_STORED_BIN_BASE64 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
    ) {
      throw new TypeError('保存的原始 BIN 数据无效')
    }
    return value
  }

  function bytesToBase64(bytes) {
    var chunks = []
    for (var offset = 0; offset < bytes.length; offset += 32768) {
      chunks.push(
        String.fromCharCode.apply(null, bytes.subarray(offset, offset + 32768))
      )
    }
    return global.btoa(chunks.join(''))
  }

  function base64ToBytes(value) {
    var binary = global.atob(normalizeStoredBinBase64(value))
    var bytes = new Uint8Array(binary.length)
    for (var index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }

  function decodeInternalServerId(serverId) {
    var numericId = Number(serverId)
    if (!Number.isSafeInteger(numericId) || numericId <= 0) {
      return {
        baseInternalId: '',
        internalId: '',
        slot: 1,
        valid: false
      }
    }
    var baseInternalId = numericId % SUB_ROLE_INTERVAL
    var slot = Math.floor(numericId / SUB_ROLE_INTERVAL) + 1
    if (baseInternalId <= 0 || slot < 1 || slot > 3) {
      return {
        baseInternalId: '',
        internalId: '',
        slot: 1,
        valid: false
      }
    }
    return {
      baseInternalId: String(baseInternalId),
      internalId: String(numericId),
      slot: slot,
      valid: true
    }
  }

  function encodeInternalServerId(baseInternalId, slot) {
    var numericBaseId = Number(baseInternalId)
    var numericSlot = Number(slot)
    if (
      !Number.isSafeInteger(numericBaseId) ||
      numericBaseId <= 0 ||
      numericBaseId >= SUB_ROLE_INTERVAL ||
      !Number.isSafeInteger(numericSlot) ||
      numericSlot < 1 ||
      numericSlot > 3
    ) {
      return ''
    }
    return String(numericBaseId + (numericSlot - 1) * SUB_ROLE_INTERVAL)
  }

  function formatServerLabel(currentCredential) {
    if (!currentCredential || currentCredential.serverId == null) return '未选择角色'
    var decoded = decodeInternalServerId(currentCredential.serverId)
    if (!decoded.valid) return '区服与角色待识别'
    var name = safeString(currentCredential.serverName)
    var roleName = safeString(currentCredential.roleName)
    return name && roleName ? name + ' · ' + roleName : '正在读取真实区服与角色'
  }

  function makeBinId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID()
    }
    return 'bin-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  }

  function findStoredBin(id) {
    for (var i = 0; i < storedBins.length; i++) {
      if (storedBins[i].id === id) return storedBins[i]
    }
    return null
  }

  function writeStoredBins() {
    try {
      global.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          selectedId: selectedBinId,
          bins: storedBins
        })
      )
    } catch (error) {
      throw new Error('无法保存账号：浏览器本地存储不可用或空间不足')
    }
  }

  function loadStoredBins() {
    var raw
    try {
      raw = global.localStorage.getItem(STORAGE_KEY)
      if (!raw) return null
      var saved = JSON.parse(raw)
      if (!saved || saved.version !== 1 || !Array.isArray(saved.bins)) {
        throw new TypeError('存储版本无效')
      }
      storedBins = saved.bins.slice(0, MAX_STORED_BINS).map(function (item) {
        if (!item || typeof item !== 'object') throw new TypeError('账号记录无效')
        return {
          id: safeString(item.id) || makeBinId(),
          name: safeString(item.name) || '未命名 BIN',
          source: item.source === 'qr' ? 'qr' : 'bin',
          credential: normalizeCredential(item.credential),
          rawBin: normalizeStoredBinBase64(item.rawBin),
          addedAt: Number(item.addedAt) || Date.now()
        }
      })
      selectedBinId = safeString(saved.selectedId)
      var selected = findStoredBin(selectedBinId)
      if (!selected) {
        selectedBinId = ''
        return null
      }
      credential = selected.credential
      credentialSource = selected.source
      return selected
    } catch (error) {
      storedBins = []
      selectedBinId = ''
      credential = null
      credentialSource = ''
      return { loadError: safeString(error.message || error) }
    }
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

  function waitForBon(timeoutMs) {
    return new Promise(function (resolve, reject) {
      var deadline = Date.now() + timeoutMs
      function check() {
        var bon = getBon()
        if (bon && typeof bon.encode === 'function') {
          resolve(bon)
          return
        }
        if (Date.now() >= deadline) {
          reject(new Error('游戏 BIN 编码组件加载超时，请刷新页面后重试'))
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
      return waitForCore(15000).then(function (core) {
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

  function onLoginResult(response) {
    if (!response || response.code) return
    setStatus((credentialSource === 'qr' ? '扫码' : 'BIN') + ' 登录成功', 'success')
    if (credentialSource !== 'bin' && credentialSource !== 'qr') {
      credential = null
      credentialSource = ''
    }
    updateBinSummary()
    cancelQr(false)
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

  function hookLoginService() {
    var service = getLoginService()
    if (!service || typeof service.authUser !== 'function') return false
    if (service === hookedService && service.authUser.__auditedAccountLogin) return true
    hookedService = service
    var originalAuthUser = service.authUser
    var wrappedAuthUser = function (request) {
      // Selecting a saved BIN deliberately reloads this document. Until then,
      // keep the launcher waiting instead of sending an empty authentication.
      if (!credential) {
        panel.hidden = false
        var launcherButton = document.querySelector('.account-login-open')
        if (launcherButton) launcherButton.setAttribute('aria-expanded', 'true')
        setStatus('请先导入 BIN 文件，然后选择账号登录', '')
        return new Promise(function () {})
      }
      return Promise.resolve(originalAuthUser.call(this, patchRequest(request))).then(
        function (response) {
          if (!awaitingServerSelection) onLoginResult(response)
          return response
        }
      )
    }
    wrappedAuthUser.__auditedAccountLogin = true
    service.authUser = wrappedAuthUser
    if (typeof service.serverList === 'function') {
      var originalServerList = service.serverList
      rawServerListService = service
      rawServerList = originalServerList
      var wrappedServerList = function (request) {
        var requestedCredential = credential
        var requestedSource = credentialSource
        var requestedRecordId = selectedBinId
        return Promise.resolve(originalServerList.call(this, patchRequest(request))).then(
          function (response) {
            lastServerListResponse = response
            lastServerListCredential = requestedCredential
            if (requestedSource === 'bin' && requestedCredential) {
              enrichStoredBinRole(response, requestedRecordId, requestedCredential)
            }
            if (awaitingServerSelection && directServerListRequests === 0) {
              presentServerListResponse(response)
            }
            return response
          }
        )
      }
      wrappedServerList.__auditedAccountLogin = true
      service.serverList = wrappedServerList
    }
    return true
  }

  function findLoginRuntime() {
    if (typeof global.__require !== 'function') return null
    var loginManager = null
    var stateMachine = null
    try {
      var loginModule = global.__require('LoginManager')
      var loginType = loginModule && (loginModule.LoginManager || loginModule.default)
      loginManager = loginType && loginType.instance ? loginType.instance : loginType
    } catch (error) {}
    try {
      var gameModule = global.__require('Game')
      var gameType = gameModule && (gameModule.Game || gameModule.default)
      var game = gameType && gameType.instance ? gameType.instance : gameType
      stateMachine = game && game.stateMachine
    } catch (error) {}
    return loginManager && stateMachine
      ? { loginManager: loginManager, stateMachine: stateMachine }
      : null
  }

  function triggerLogin() {
    hookLoginService()
    var runtime = findLoginRuntime()
    if (!runtime) {
      setStatus('登录数据已就绪，将在游戏下一次认证时使用', 'ready')
      return
    }
    try {
      var types = global.__require('types-common')
      if (!types || !types.GameState || types.GameState.SwitchRole == null) {
        setStatus('登录数据已就绪，请在游戏内切换角色', 'ready')
        return
      }
      runtime.loginManager.isManualSwitchRole = true
      runtime.stateMachine.transition(types.GameState.SwitchRole)
      setStatus('正在切换登录…', 'busy')
    } catch (error) {
      setStatus('登录数据已就绪，请在游戏内切换角色', 'ready')
    }
  }

  function restartWithStoredCredential() {
    var record = findStoredBin(selectedBinId)
    if (!record || !credential || record.credential !== credential) {
      triggerLogin()
      return
    }

    setStatus('登录信息已保存，正在重新进入游戏…', 'busy')
    global.setTimeout(function () {
      global.location.reload()
    }, 50)
  }

  function prepareCredential(payload, source) {
    var nextCredential = normalizeCredential(payload)
    if (source === 'qr') {
      var timestamp = new Date().toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
      pendingQrAccountName = '微信扫码 ' + timestamp
    }
    credential = nextCredential
    credentialSource = source || 'external'
    hookLoginService()
    updateBinSummary()
    if (source === 'qr') {
      showServerPicker()
      return
    }
    triggerLogin()
  }

  function readOwnRoleSlots(roles) {
    var slotsByBaseId = Object.create(null)

    function addRole(serverId, roleInfo) {
      var decoded = decodeInternalServerId(serverId)
      if (!decoded.valid) return
      if (!slotsByBaseId[decoded.baseInternalId]) {
        slotsByBaseId[decoded.baseInternalId] = {}
      }
      slotsByBaseId[decoded.baseInternalId][decoded.slot] = {
        name: safeString(
          roleInfo && (roleInfo.name || roleInfo.roleName || roleInfo.nickname)
        ),
        level: Number(roleInfo && (roleInfo.level || roleInfo.levelId)) || 0
      }
    }

    if (!roles) return slotsByBaseId
    if (Array.isArray(roles)) {
      roles.forEach(function (entry) {
        if (!entry || typeof entry !== 'object') return
        var roleInfo = entry.value || entry.roleInfo || entry
        addRole(entry.key || entry.serverId || (roleInfo && roleInfo.serverId), roleInfo)
      })
      return slotsByBaseId
    }
    if (typeof roles.forEach === 'function') {
      roles.forEach(function (roleInfo, serverId) {
        addRole(serverId || (roleInfo && roleInfo.serverId), roleInfo)
      })
      return slotsByBaseId
    }
    if (typeof roles === 'object') {
      Object.keys(roles).forEach(function (serverId) {
        var roleInfo = roles[serverId]
        addRole(serverId || (roleInfo && roleInfo.serverId), roleInfo)
      })
    }
    return slotsByBaseId
  }

  function unwrapServerListResponse(response) {
    if (response && typeof response.getData === 'function') {
      try {
        return response.getData()
      } catch (error) {}
    }
    return response
  }

  function collectServerOptions(payload) {
    payload = unwrapServerListResponse(payload)
    var results = []
    var hasOfficialServerList =
      payload && typeof payload === 'object' && Array.isArray(payload.serverList)
    var roleStatusKnown =
      payload &&
      typeof payload === 'object' &&
      Object.prototype.hasOwnProperty.call(payload, 'roles')

    if (!hasOfficialServerList) {
      results.roleStatusKnown = false
      return results
    }

    var roleSlotsByBaseId = readOwnRoleSlots(payload.roles)
    var officialServersById = Object.create(null)
    var officialServerOrder = []
    payload.serverList.forEach(function (server) {
      if (!server || typeof server !== 'object') return
      var id = firstValue(
        server.id,
        server.serverId,
        server.serverID,
        server.server_id
      )
      var decoded = decodeInternalServerId(id)
      if (!decoded.valid) return
      var name = firstValue(
        server.serverName,
        server.server_name,
        server.name,
        server.displayName
      )
      if (!officialServersById[decoded.baseInternalId]) {
        officialServerOrder.push(decoded.baseInternalId)
      }
      officialServersById[decoded.baseInternalId] = {
        id: decoded.baseInternalId,
        name: safeString(name) || '内部区服 ' + decoded.baseInternalId,
        roles: roleSlotsByBaseId[decoded.baseInternalId] || {},
        roleStatusKnown: !!roleStatusKnown
      }
    })
    officialServerOrder.forEach(function (baseInternalId) {
      results.push(officialServersById[baseInternalId])
    })
    results.roleStatusKnown = !!roleStatusKnown
    return results
  }

  function findCredentialRole(options, currentCredential) {
    var decoded = decodeInternalServerId(currentCredential && currentCredential.serverId)
    if (!decoded.valid || !options.roleStatusKnown) return null
    for (var index = 0; index < options.length; index++) {
      var server = options[index]
      if (String(server.id) !== String(decoded.baseInternalId)) continue
      var role = server.roles && server.roles[decoded.slot]
      if (!role) return null
      var serverName = safeString(server.name)
      if (!serverName || serverName.indexOf('内部区服 ') === 0) return null
      return {
        serverName: serverName,
        roleName: safeString(role.name) || '未命名角色'
      }
    }
    return null
  }

  function enrichStoredBinRole(response, recordId, requestedCredential) {
    if (!response || (Number(response.code) || 0)) return false
    var matchedRole = findCredentialRole(
      collectServerOptions(response),
      requestedCredential
    )
    if (!matchedRole || !matchedRole.serverName) return false

    var record = findStoredBin(recordId)
    if (
      !record ||
      record.source !== 'bin' ||
      record.credential.info !== requestedCredential.info ||
      record.credential.platformExt !== requestedCredential.platformExt ||
      safeString(record.credential.serverId) !== safeString(requestedCredential.serverId)
    ) {
      return false
    }

    var previousServerName = record.credential.serverName
    var previousRoleName = record.credential.roleName
    record.credential.serverName = matchedRole.serverName
    record.credential.roleName = matchedRole.roleName
    try {
      writeStoredBins()
    } catch (error) {
      record.credential.serverName = previousServerName
      record.credential.roleName = previousRoleName
      setStatus(safeString(error.message || error), 'error')
      return false
    }

    if (selectedBinId === record.id) {
      credential = record.credential
    }
    renderBinList()
    updateBinSummary()
    return true
  }

  function makeRoleListRequest(currentCredential, includeCompatibilityFields) {
    var platform = currentCredential.platform || 'hortor'
    var request = {
      platform: platform,
      platformExt: currentCredential.platformExt,
      info: currentCredential.info,
      serverId: null,
      scene: 0,
      referrerInfo: '',
      rtt: 0
    }
    if (includeCompatibilityFields) {
      request.oriPlatform = platform
      request.areaId = 0
    }
    return request
  }

  function loadStoredBinRole(recordId, requestedCredential) {
    return new Promise(function (resolve, reject) {
      var deadline = Date.now() + 10000

      function tryLoad() {
        var record = findStoredBin(recordId)
        if (
          !record ||
          record.source !== 'bin' ||
          record.credential !== requestedCredential
        ) {
          reject(new Error('BIN 账号选择已变化'))
          return
        }

        hookLoginService()
        var service = getLoginService()
        if (
          !service ||
          rawServerListService !== service ||
          typeof rawServerList !== 'function'
        ) {
          if (Date.now() < deadline) {
            global.setTimeout(tryLoad, 250)
            return
          }
          reject(new Error('游戏已有角色组件加载超时'))
          return
        }

        var requestPromise
        try {
          requestPromise = Promise.resolve(
            rawServerList.call(service, makeRoleListRequest(requestedCredential, false))
          )
        } catch (error) {
          reject(error)
          return
        }
        requestPromise.then(
          function (response) {
            if (enrichStoredBinRole(response, recordId, requestedCredential)) {
              resolve(true)
              return
            }
            reject(new Error('未读取到该 BIN 对应的正式区服和角色'))
          },
          reject
        )
      }

      tryLoad()
    })
  }

  function hasCredentialRoleLabel(currentCredential) {
    return !!(
      safeString(currentCredential && currentCredential.serverName) &&
      safeString(currentCredential && currentCredential.roleName)
    )
  }

  function triggerStoredBinLogin(recordId, requestedCredential) {
    if (hasCredentialRoleLabel(requestedCredential)) {
      restartWithStoredCredential()
      return
    }

    setStatus('正在读取 BIN 对应的真实区服与角色…', 'busy')
    loadStoredBinRole(recordId, requestedCredential).then(
      function () {
        if (selectedBinId !== recordId || credential !== requestedCredential) return
        setStatus(
          '已读取 ' + formatServerLabel(requestedCredential) + '，正在登录…',
          'busy'
        )
        restartWithStoredCredential()
      },
      function () {
        if (selectedBinId !== recordId || credential !== requestedCredential) return
        setStatus('暂未读取到真实区服与角色，正在继续登录…', 'busy')
        restartWithStoredCredential()
      }
    )
  }

  function renderServerOptions(options) {
    if (!serverSelect) return
    serverSelect.textContent = ''
    currentRoleOptions = []
    options.forEach(function (server) {
      var decoded = decodeInternalServerId(server.id)
      if (!decoded.valid) return
      var serverName = safeString(server.name) || '内部区服 ' + decoded.baseInternalId
      Object.keys(server.roles || {})
        .map(Number)
        .sort(function (left, right) {
          return left - right
        })
        .forEach(function (slot) {
          var role = server.roles[slot]
          var internalId = encodeInternalServerId(decoded.baseInternalId, slot)
          if (!internalId || !role) return
          var roleName = safeString(role.name) || '未命名角色'
          currentRoleOptions.push({
            internalId: internalId,
            serverName: serverName,
            roleName: roleName,
            slot: slot
          })
          var label = document.createElement('label')
          label.className = 'account-login-role-option'
          var checkbox = document.createElement('input')
          checkbox.type = 'checkbox'
          checkbox.value = internalId
          var text = document.createElement('span')
          text.textContent = serverName + ' · ' + roleName
          label.appendChild(checkbox)
          label.appendChild(text)
          serverSelect.appendChild(label)
        })
    })
    serverSelect.setAttribute(
      'aria-disabled',
      currentRoleOptions.length === 0 ? 'true' : 'false'
    )
    if (!currentRoleOptions.length) {
      var empty = document.createElement('p')
      empty.className = 'account-login-role-empty'
      empty.textContent = '暂无可添加的已有角色'
      serverSelect.appendChild(empty)
    }
  }

  function findCurrentRoleOption(internalId) {
    var wantedId = safeString(internalId)
    for (var i = 0; i < currentRoleOptions.length; i++) {
      if (currentRoleOptions[i].internalId === wantedId) {
        return currentRoleOptions[i]
      }
    }
    return null
  }

  function readSelectedRoleOptions() {
    if (!serverSelect) return []
    var selectedRoles = []
    Array.prototype.forEach.call(
      serverSelect.querySelectorAll('input[type="checkbox"]:checked'),
      function (checkbox) {
        var role = findCurrentRoleOption(checkbox.value)
        if (role) selectedRoles.push(role)
      }
    )
    return selectedRoles
  }

  function presentServerListResponse(response) {
    if (serverDiscoveryTimer) global.clearTimeout(serverDiscoveryTimer)
    serverDiscoveryTimer = 0
    var responseCode = Number(response && response.code) || 0
    if (responseCode) {
      renderServerOptions([])
      setStatus('区服列表接口返回错误（代码 ' + responseCode + '），请重新扫码后重试', 'error')
      return
    }
    var responseData = unwrapServerListResponse(response)
    var options = collectServerOptions(responseData)
    var visibleOptions = options
    if (options.roleStatusKnown) {
      visibleOptions = options.filter(function (server) {
        return Object.keys(server.roles || {}).length > 0
      })
    }
    renderServerOptions(visibleOptions)
    var roleEntryCount = options.reduce(function (count, server) {
      return count + Object.keys(server.roles || {}).length
    }, 0)
    setStatus(
      options.roleStatusKnown
        ? roleEntryCount
          ? '已读取到 ' +
            roleEntryCount +
            ' 个已有角色（分布在 ' +
            visibleOptions.length +
            ' 个区服），可勾选多个角色后添加'
          : '该微信账号未返回任何已有角色；可重新扫码确认账号'
        : '游戏返回的已有角色数据格式无法识别，请重新扫码',
      roleEntryCount ? 'ready' : 'error'
    )
  }

  function loadServerOptions() {
    var cachedOptions = collectServerOptions(
      lastServerListCredential === credential ? lastServerListResponse : null
    )
    if (cachedOptions.length) {
      var visibleCachedOptions = cachedOptions.roleStatusKnown
        ? cachedOptions.filter(function (server) {
            return Object.keys(server.roles || {}).length > 0
          })
        : cachedOptions
      renderServerOptions(visibleCachedOptions)
      var cachedRoleCount = cachedOptions.reduce(function (count, server) {
        return count + Object.keys(server.roles || {}).length
      }, 0)
      setStatus(
        cachedOptions.roleStatusKnown
          ? '扫码成功，已读取到 ' + cachedRoleCount + ' 个已有角色'
          : '接口未提供角色归属数据，无法安全列出已有角色',
        cachedRoleCount ? 'ready' : 'error'
      )
      return
    }

    setStatus('扫码成功，正在通过游戏加载区服列表…', 'busy')
    var deadline = Date.now() + 15000

    function tryRequestServerList() {
      if (!awaitingServerSelection) return
      hookLoginService()
      var service = getLoginService()
      if (!service || typeof service.serverList !== 'function') {
        if (Date.now() < deadline) {
          serverDiscoveryTimer = global.setTimeout(tryRequestServerList, 300)
          return
        }
        serverDiscoveryTimer = 0
        renderServerOptions([])
        setStatus('游戏已有角色组件加载超时，请重新扫码后重试', 'error')
        return
      }

      serverDiscoveryTimer = 0
      var userscriptRequest = makeRoleListRequest(credential, false)
      var gameRequest = makeRoleListRequest(credential, true)

      function requestVariant(request, allowFallback) {
        directServerListRequests++
        var requestPromise
        try {
          requestPromise = Promise.resolve(service.serverList(request))
        } catch (error) {
          directServerListRequests--
          return Promise.reject(error)
        }
        return requestPromise.then(
          function (response) {
            directServerListRequests--
            if (!awaitingServerSelection) return
            var responseData = unwrapServerListResponse(response)
            var options = response && response.code ? [] : collectServerOptions(responseData)
            var roleEntryCount = options.reduce(function (count, server) {
              return count + Object.keys(server.roles || {}).length
            }, 0)
            if (
              allowFallback &&
              !response.code &&
              options.roleStatusKnown &&
              roleEntryCount === 0
            ) {
              setStatus('扫码凭据已返回，正在尝试游戏标准区服请求…', 'busy')
              return requestVariant(gameRequest, false)
            }
            presentServerListResponse(response)
          },
          function (error) {
            directServerListRequests--
            throw error
          }
        )
      }

      requestVariant(userscriptRequest, true).catch(function (error) {
        if (!awaitingServerSelection) return
        renderServerOptions([])
        setStatus('区服列表读取失败：' + safeString(error.message || error), 'error')
      })
    }

    tryRequestServerList()
  }

  function showServerPicker() {
    if (!serverPicker) {
      triggerLogin()
      return
    }
    awaitingServerSelection = true
    serverPicker.hidden = false
    qrStartButton.hidden = true
    renderServerOptions([])
    loadServerOptions()
  }

  function confirmServerSelection() {
    if (!credential) {
      setStatus('扫码登录信息已失效，请重新扫码', 'error')
      return
    }
    var selectedRoles = readSelectedRoleOptions()
    if (!selectedRoles.length) {
      setStatus('请至少勾选一个已有角色', 'error')
      return
    }
    var records = selectedRoles.map(function (selectedRole) {
      var roleCredential = Object.assign({}, credential, {
        serverId: selectedRole.internalId,
        serverName: selectedRole.serverName,
        roleName: selectedRole.roleName
      })
      return {
        name: selectedRole.serverName + ' · ' + selectedRole.roleName,
        credential: roleCredential,
        source: 'qr'
      }
    })
    try {
      addStoredCredentials(records)
    } catch (error) {
      setStatus(safeString(error.message || error), 'error')
      return
    }
    pendingQrAccountName = ''
    awaitingServerSelection = false
    if (serverDiscoveryTimer) global.clearTimeout(serverDiscoveryTimer)
    serverDiscoveryTimer = 0
    serverPicker.hidden = true
    qrStartButton.hidden = false
    var previousRecord = findStoredBin(selectedBinId)
    credential = previousRecord ? previousRecord.credential : null
    credentialSource = previousRecord ? previousRecord.source : ''
    renderBinList()
    updateBinSummary()
    showTab('bin')
    setStatus('已将 ' + selectedRoles.length + ' 个角色添加到 BIN 登录账号列表', 'success')
  }

  function selectStoredBin(id, shouldLogin) {
    var record = findStoredBin(id)
    if (!record) return
    selectedBinId = record.id
    credential = record.credential
    credentialSource = record.source
    writeStoredBins()
    renderBinList()
    updateBinSummary()
    if (shouldLogin) {
      setStatus('已选择 ' + record.name + '，正在登录…', 'busy')
      if (record.source === 'bin') {
        triggerStoredBinLogin(record.id, record.credential)
      } else {
        restartWithStoredCredential()
      }
    }
  }

  function addStoredCredential(name, nextCredential, source, rawBin) {
    var previousBins = storedBins.slice()
    var previousSelectedId = selectedBinId
    var existing = null
    if (source === 'qr') {
      for (var index = 0; index < storedBins.length; index++) {
        var saved = storedBins[index]
        if (
          saved.credential.info === nextCredential.info &&
          saved.credential.platformExt === nextCredential.platformExt &&
          safeString(saved.credential.serverId) === safeString(nextCredential.serverId)
        ) {
          existing = saved
          break
        }
      }
    }
    var record = {
      id: existing ? existing.id : makeBinId(),
      name: existing ? existing.name : safeString(name) || '未命名账号',
      source: source === 'qr' ? 'qr' : 'bin',
      credential: nextCredential,
      rawBin: source === 'bin' ? normalizeStoredBinBase64(rawBin) : '',
      addedAt: Date.now()
    }
    storedBins = [record].concat(
      storedBins.filter(function (item) {
        return item.id !== record.id
      })
    )
    if (storedBins.length > MAX_STORED_BINS) storedBins.length = MAX_STORED_BINS
    selectedBinId = record.id
    try {
      writeStoredBins()
    } catch (error) {
      storedBins = previousBins
      selectedBinId = previousSelectedId
      throw error
    }
    return record
  }

  function addStoredCredentials(entries) {
    var previousBins = storedBins.slice()
    var previousSelectedId = selectedBinId
    var nextBins = storedBins.slice()
    entries.forEach(function (entry) {
      var existing = null
      for (var index = 0; index < nextBins.length; index++) {
        var saved = nextBins[index]
        if (
          saved.credential.info === entry.credential.info &&
          saved.credential.platformExt === entry.credential.platformExt &&
          safeString(saved.credential.serverId) === safeString(entry.credential.serverId)
        ) {
          existing = saved
          break
        }
      }
      var record = {
        id: existing ? existing.id : makeBinId(),
        name: existing ? existing.name : safeString(entry.name) || '未命名账号',
        source: 'qr',
        credential: entry.credential,
        rawBin: '',
        addedAt: Date.now()
      }
      nextBins = [record].concat(
        nextBins.filter(function (item) {
          return item.id !== record.id
        })
      )
    })
    if (nextBins.length > MAX_STORED_BINS) {
      throw new Error('无法同时添加：保存后账号数量将超过 ' + MAX_STORED_BINS + ' 个')
    }
    storedBins = nextBins
    try {
      writeStoredBins()
    } catch (error) {
      storedBins = previousBins
      selectedBinId = previousSelectedId
      throw error
    }
  }

  function addStoredBin(file, nextCredential, rawBin) {
    return addStoredCredential(
      safeString(file && file.name) || '未命名 BIN',
      nextCredential,
      'bin',
      rawBin
    )
  }

  function makeBinDownloadName(name) {
    var fileName = safeString(name)
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
      .replace(/[. ]+$/g, '')
      .replace(/\.bin$/i, '')
      .trim()
    if (!fileName || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(fileName)) {
      fileName = 'account'
    }
    return fileName.slice(0, 120) + '.bin'
  }

  function makeStandardBinPayload(currentCredential) {
    var normalized = normalizeCredential(currentCredential)
    var info
    try {
      info = JSON.parse(normalized.info)
    } catch (error) {
      throw new Error('登录 info 不是可导出的 JSON 对象')
    }
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      throw new Error('登录 info 不是可导出的 JSON 对象')
    }
    var serverId = Number(normalized.serverId)
    if (!Number.isSafeInteger(serverId) || serverId <= 0) {
      throw new Error('登录 serverId 不是有效数字')
    }
    return {
      platform: normalized.platform,
      platformExt: normalized.platformExt,
      info: info,
      serverId: serverId,
      scene: 0,
      referrerInfo: ''
    }
  }

  function verifyStandardBinPayload(decoded, expected) {
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('BIN 往返校验失败')
    }
    if (
      decoded.platform !== expected.platform ||
      decoded.platformExt !== expected.platformExt ||
      typeof decoded.serverId !== 'number' ||
      decoded.serverId !== expected.serverId ||
      decoded.scene !== 0 ||
      decoded.referrerInfo !== '' ||
      JSON.stringify(decoded.info) !== JSON.stringify(expected.info)
    ) {
      throw new Error('BIN 往返校验失败')
    }
  }

  function encodeStandardBinPayload(payload) {
    return Promise.all([waitForCore(15000), waitForBon(15000)]).then(function (codecs) {
      var core = codecs[0]
      var bon = codecs[1]
      if (typeof core.lz4XorEncode !== 'function') {
        throw new Error('游戏 BIN 编码组件不可用，请刷新页面后重试')
      }
      var bonBytes = bon.encode(payload, false)
      if (!(bonBytes instanceof Uint8Array)) bonBytes = new Uint8Array(bonBytes)
      if (bonBytes.byteLength <= 0 || bonBytes.byteLength > MAX_DECODED_BYTES) {
        throw new Error('账号数据超出 BIN 编码大小限制')
      }
      var encoded = core.lz4XorEncode(bonBytes.slice())
      if (!(encoded instanceof Uint8Array)) encoded = new Uint8Array(encoded)
      if (encoded.byteLength <= 0 || encoded.byteLength > MAX_BIN_BYTES) {
        throw new Error('生成的 BIN 超出 2 MB 大小限制')
      }
      var decoded = core.lz4XorDecode(encoded.slice())
      if (!(decoded instanceof Uint8Array)) decoded = new Uint8Array(decoded)
      verifyStandardBinPayload(bon.decode(decoded), payload)
      return encoded
    })
  }

  function downloadStoredBin(id) {
    var record = findStoredBin(id)
    if (!record) throw new Error('未找到要下载的账号')
    if (record.rawBin) {
      var originalBytes = base64ToBytes(record.rawBin)
      if (originalBytes.byteLength <= 0 || originalBytes.byteLength > MAX_BIN_BYTES) {
        throw new Error('保存的原始 BIN 超出大小限制')
      }
      setStatus('正在校验 BIN…', 'busy')
      return decodeBin(originalBytes.slice()).then(function (payload) {
        normalizeCredential(payload)
        saveBinDownload(record, originalBytes)
      })
    }
    var payload = makeStandardBinPayload(record.credential)
    setStatus('正在生成并校验 BIN…', 'busy')
    return encodeStandardBinPayload(payload).then(function (encoded) {
      saveBinDownload(record, encoded)
    })
  }

  function saveBinDownload(record, bytes) {
    var blob = new Blob([bytes], { type: 'application/octet-stream' })
    var objectUrl = global.URL.createObjectURL(blob)
    var link = document.createElement('a')
    link.hidden = true
    link.download = makeBinDownloadName(record.name)
    link.href = objectUrl
    document.body.appendChild(link)
    try {
      link.click()
    } finally {
      document.body.removeChild(link)
      global.setTimeout(function () {
        global.URL.revokeObjectURL(objectUrl)
      }, 0)
    }
    setStatus('BIN 已保存', 'success')
  }

  function renameStoredBin(id) {
    var record = findStoredBin(id)
    if (!record) return
    var nextName = global.prompt('输入新的账号名称', record.name)
    if (nextName == null) return
    nextName = safeString(nextName.trim())
    if (!nextName) {
      setStatus('名称不能为空', 'error')
      return
    }
    record.name = nextName
    writeStoredBins()
    renderBinList()
    updateBinSummary()
  }

  function deleteStoredBin(id) {
    var record = findStoredBin(id)
    if (!record || !global.confirm('删除本地保存的“' + record.name + '”？')) return
    storedBins = storedBins.filter(function (item) {
      return item.id !== id
    })
    if (selectedBinId === id) {
      selectedBinId = ''
      credential = null
      credentialSource = ''
    }
    writeStoredBins()
    renderBinList()
    updateBinSummary()
    setStatus('已删除本地账号记录', '')
  }

  function clearStoredBins() {
    if (!storedBins.length || !global.confirm('清空当前站点保存的全部登录信息？')) return
    storedBins = []
    selectedBinId = ''
    credential = null
    credentialSource = ''
    writeStoredBins()
    renderBinList()
    updateBinSummary()
    setStatus('已清空全部本地登录信息', '')
  }

  function renderBinList() {
    if (!binListNode) return
    binListNode.textContent = ''
    if (clearBinsButton) clearBinsButton.hidden = storedBins.length === 0
    if (!storedBins.length) {
      var empty = document.createElement('p')
      empty.className = 'account-login-empty'
      empty.textContent = '尚未保存账号'
      binListNode.appendChild(empty)
      return
    }
    storedBins.forEach(function (record) {
      var item = document.createElement('article')
      item.className =
        'account-login-bin-item' + (record.id === selectedBinId ? ' is-selected' : '')

      var details = document.createElement('div')
      details.className = 'account-login-bin-details'
      var name = document.createElement('strong')
      name.textContent = record.name
      var meta = document.createElement('small')
      var server = formatServerLabel(record.credential)
      meta.textContent =
        (record.source === 'qr' ? '微信扫码 · ' : 'BIN · ') +
        server +
        (record.id === selectedBinId ? ' · 当前使用' : '')
      details.appendChild(name)
      details.appendChild(meta)

      var actions = document.createElement('div')
      actions.className = 'account-login-bin-actions'
      var loginButton = document.createElement('button')
      loginButton.type = 'button'
      loginButton.textContent = record.id === selectedBinId ? '重新登录' : '登录'
      loginButton.addEventListener('click', function () {
        try {
          selectStoredBin(record.id, true)
        } catch (error) {
          setStatus(safeString(error.message || error), 'error')
        }
      })
      var downloadButton = document.createElement('button')
      downloadButton.type = 'button'
      downloadButton.textContent = '下载 BIN'
      downloadButton.addEventListener('click', function () {
        try {
          Promise.resolve(downloadStoredBin(record.id)).catch(function (error) {
            setStatus(safeString(error.message || error), 'error')
          })
        } catch (error) {
          setStatus(safeString(error.message || error), 'error')
        }
      })
      var renameButton = document.createElement('button')
      renameButton.type = 'button'
      renameButton.textContent = '改名'
      renameButton.addEventListener('click', function () {
        try {
          renameStoredBin(record.id)
        } catch (error) {
          setStatus(safeString(error.message || error), 'error')
        }
      })
      var deleteButton = document.createElement('button')
      deleteButton.type = 'button'
      deleteButton.textContent = '删除'
      deleteButton.addEventListener('click', function () {
        try {
          deleteStoredBin(record.id)
        } catch (error) {
          setStatus(safeString(error.message || error), 'error')
        }
      })
      actions.appendChild(loginButton)
      actions.appendChild(downloadButton)
      actions.appendChild(renameButton)
      actions.appendChild(deleteButton)
      item.appendChild(details)
      item.appendChild(actions)
      binListNode.appendChild(item)
    })
  }

  function updateBinSummary() {
    if (!binSummary) return
    if (credential && credentialSource === 'qr' && pendingQrAccountName) {
      binSummary.textContent = pendingQrAccountName + ' · 待选择区服'
      return
    }
    if (!credential || (credentialSource !== 'bin' && credentialSource !== 'qr')) {
      binSummary.textContent = '未选择登录账号'
      return
    }
    var record = findStoredBin(selectedBinId)
    var fileName = record ? record.name : '已载入账号'
    var server = formatServerLabel(credential)
    binSummary.textContent =
      (fileName === server ? fileName : fileName + ' · ' + server) +
      ' · 已保存在此浏览器'
  }

  function importBin(file) {
    if (!file) return
    if (file.size <= 0 || file.size > MAX_BIN_BYTES) {
      setStatus('BIN 文件大小必须在 1 B 至 2 MB 之间', 'error')
      return
    }
    setStatus('正在校验 BIN…', 'busy')
    file.arrayBuffer()
      .then(function (buffer) {
        var sourceBytes = new Uint8Array(buffer)
        var rawBin = bytesToBase64(sourceBytes)
        return decodeBin(sourceBytes).then(function (payload) {
          return { payload: payload, rawBin: rawBin }
        })
      })
      .then(function (decoded) {
        var nextCredential = normalizeCredential(decoded.payload)
        addStoredBin(file, nextCredential, decoded.rawBin)
        credential = nextCredential
        credentialSource = 'bin'
        renderBinList()
        updateBinSummary()
        hookLoginService()
        triggerStoredBinLogin(selectedBinId, nextCredential)
      })
      .catch(function (error) {
        var selected = findStoredBin(selectedBinId)
        credential = selected ? selected.credential : null
        credentialSource = selected ? 'bin' : ''
        renderBinList()
        updateBinSummary()
        setStatus(safeString(error.message || error), 'error')
      })
      .finally(function () {
        fileInput.value = ''
      })
  }

  function registerQrProvider(provider) {
    if (!provider || typeof provider.start !== 'function') {
      throw new TypeError('扫码提供方必须实现 start()')
    }
    qrProvider = provider
    if (qrStartButton) qrStartButton.disabled = false
    setStatus('已连接官方扫码登录服务', 'ready')
  }

  function cancelQr(notifyProvider) {
    if (qrTimer) global.clearInterval(qrTimer)
    qrTimer = 0
    if (notifyProvider !== false && qrSession && typeof qrSession.cancel === 'function') {
      try {
        qrSession.cancel()
      } catch (error) {}
    }
    qrSession = null
    if (qrImage) {
      qrImage.removeAttribute('src')
      qrImage.hidden = true
    }
    if (qrPlaceholder) qrPlaceholder.hidden = false
    if (qrStartButton) qrStartButton.hidden = false
    if (qrCancelButton) qrCancelButton.hidden = true
  }

  function pollQrSession() {
    if (!qrSession || typeof qrSession.poll !== 'function') return
    Promise.resolve(qrSession.poll())
      .then(function (result) {
        if (!result || !qrSession) return
        if (result.status === 'confirmed' || result.status === 'authorized') {
          if (!result.credential) throw new Error('扫码服务未返回登录凭据')
          cancelQr(false)
          prepareCredential(result.credential, 'qr')
        } else if (result.status === 'scanned') {
          setStatus('已扫码，请在官方客户端确认', 'busy')
        } else if (result.status === 'expired') {
          cancelQr(false)
          setStatus('二维码已过期，请重新获取', 'error')
        } else if (result.status === 'error') {
          throw new Error(result.message || '扫码登录失败')
        }
      })
      .catch(function (error) {
        cancelQr(false)
        setStatus(safeString(error.message || error), 'error')
      })
  }

  function startQr() {
    if (!qrProvider) {
      setStatus('当前页面未配置官方扫码服务', 'error')
      return
    }
    cancelQr(false)
    if (pendingQrAccountName) {
      var previousRecord = findStoredBin(selectedBinId)
      credential = previousRecord ? previousRecord.credential : null
      credentialSource = previousRecord ? previousRecord.source : ''
      pendingQrAccountName = ''
      updateBinSummary()
    }
    if (serverPicker) serverPicker.hidden = true
    setStatus('正在获取官方二维码…', 'busy')
    Promise.resolve(qrProvider.start())
      .then(function (session) {
        var imageUrl = session && (session.imageUrl || session.qrImageUrl)
        if (!imageUrl) throw new Error('扫码服务未返回二维码图片')
        qrSession = session
        qrImage.src = imageUrl
        qrImage.hidden = false
        qrPlaceholder.hidden = true
        qrStartButton.hidden = true
        qrCancelButton.hidden = false
        setStatus('请使用官方客户端扫码并确认', 'busy')
        if (typeof session.poll === 'function') {
          qrTimer = global.setInterval(pollQrSession, 1200)
        }
      })
      .catch(function (error) {
        cancelQr(false)
        setStatus(safeString(error.message || error), 'error')
      })
  }

  function showTab(name) {
    if (name === 'scripts') attachScriptTool()
    Array.prototype.forEach.call(panel.querySelectorAll('[data-login-tab]'), function (tab) {
      var selected = tab.getAttribute('data-login-tab') === name
      tab.classList.toggle('is-active', selected)
      tab.setAttribute('aria-selected', selected ? 'true' : 'false')
    })
    Array.prototype.forEach.call(panel.querySelectorAll('[data-login-page]'), function (page) {
      page.hidden = page.getAttribute('data-login-page') !== name
    })
    if (statusNode) statusNode.hidden = name === 'scripts'
  }

  function attachScriptTool() {
    if (!panel) return false
    var host = panel.querySelector('.account-login-script-host')
    var tab = panel.querySelector('[data-login-tab="scripts"]')
    var container = document.getElementById('script-tool-container')
    var scriptPanel = document.getElementById('script-tool-panel')
    var toggle = document.getElementById('script-tool-toggle')
    if (!host || !tab || !container || !scriptPanel || !toggle) return false
    if (container.parentNode === host) return true

    toggle.hidden = true
    toggle.style.display = 'none'
    toggle.setAttribute('aria-hidden', 'true')
    container.classList.add('is-embedded')
    scriptPanel.classList.add('show', 'is-embedded')
    var scriptHeader = scriptPanel.querySelector('.panel-header')
    if (scriptHeader && scriptHeader.parentNode) scriptHeader.parentNode.removeChild(scriptHeader)
    host.textContent = ''
    host.appendChild(container)
    tab.hidden = false
    var tabs = panel.querySelector('.account-login-tabs')
    if (tabs) tabs.classList.add('has-script-tool')
    return true
  }

  function scheduleScriptToolAttachment() {
    if (attachScriptTool()) return
    document.addEventListener(
      'DOMContentLoaded',
      function () {
        global.setTimeout(attachScriptTool, 0)
      },
      false
    )
  }

  function placeOpenButton(button, left, top, shouldSave) {
    if (!Number.isFinite(left) || !Number.isFinite(top)) return
    var maxLeft = Math.max(0, global.innerWidth - button.offsetWidth)
    var maxTop = Math.max(0, global.innerHeight - button.offsetHeight)
    var nextLeft = Math.max(0, Math.min(left, maxLeft))
    var nextTop = Math.max(0, Math.min(top, maxTop))
    button.style.left = nextLeft + 'px'
    button.style.top = nextTop + 'px'
    button.style.right = 'auto'
    button.style.bottom = 'auto'
    if (!shouldSave) return
    try {
      global.localStorage.setItem(
        BUTTON_POSITION_KEY,
        JSON.stringify({ left: nextLeft, top: nextTop })
      )
    } catch (error) {}
  }

  function restoreOpenButtonPosition(button) {
    try {
      var saved = JSON.parse(global.localStorage.getItem(BUTTON_POSITION_KEY) || 'null')
      if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return
      placeOpenButton(button, saved.left, saved.top, false)
    } catch (error) {}
  }

  function makeOpenButtonDraggable(button, onActivate) {
    var dragState = null
    var ignoreClickUntil = 0

    function startDrag(clientX, clientY, inputId) {
      if (dragState) return
      var rect = button.getBoundingClientRect()
      dragState = {
        inputId: inputId,
        startX: clientX,
        startY: clientY,
        startLeft: rect.left,
        startTop: rect.top,
        moved: false
      }
      button.classList.add('is-dragging')
    }

    function moveDrag(clientX, clientY, inputId, event) {
      if (!dragState || inputId !== dragState.inputId) return
      var deltaX = clientX - dragState.startX
      var deltaY = clientY - dragState.startY
      if (
        !dragState.moved &&
        Math.sqrt(deltaX * deltaX + deltaY * deltaY) >= BUTTON_DRAG_THRESHOLD
      ) {
        dragState.moved = true
      }
      if (!dragState.moved) return
      placeOpenButton(
        button,
        dragState.startLeft + deltaX,
        dragState.startTop + deltaY,
        false
      )
      event.preventDefault()
    }

    function finishDrag(inputId, event, cancelled) {
      if (!dragState || inputId !== dragState.inputId) return
      var moved = dragState.moved
      dragState = null
      button.classList.remove('is-dragging')
      ignoreClickUntil = Date.now() + 300
      if (moved) {
        var rect = button.getBoundingClientRect()
        placeOpenButton(button, rect.left, rect.top, true)
      } else if (!cancelled) {
        onActivate()
      }
      if (event.cancelable) event.preventDefault()
    }

    if ('PointerEvent' in global) {
      button.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return
        startDrag(event.clientX, event.clientY, event.pointerId)
        if (typeof button.setPointerCapture === 'function') {
          button.setPointerCapture(event.pointerId)
        }
      })
      button.addEventListener('pointermove', function (event) {
        moveDrag(event.clientX, event.clientY, event.pointerId, event)
      })
      button.addEventListener('pointerup', function (event) {
        finishDrag(event.pointerId, event, false)
      })
      button.addEventListener('pointercancel', function (event) {
        finishDrag(event.pointerId, event, true)
      })
    } else {
      button.addEventListener('mousedown', function (event) {
        if (event.button !== 0) return
        startDrag(event.clientX, event.clientY, 'mouse')
      })
      global.addEventListener('mousemove', function (event) {
        moveDrag(event.clientX, event.clientY, 'mouse', event)
      })
      global.addEventListener('mouseup', function (event) {
        finishDrag('mouse', event, false)
      })
      button.addEventListener(
        'touchstart',
        function (event) {
          if (!event.touches.length) return
          var touch = event.touches[0]
          startDrag(touch.clientX, touch.clientY, touch.identifier)
          event.preventDefault()
        },
        { passive: false }
      )
      global.addEventListener(
        'touchmove',
        function (event) {
          if (!dragState || dragState.inputId === 'mouse') return
          for (var index = 0; index < event.touches.length; index++) {
            var touch = event.touches[index]
            if (touch.identifier === dragState.inputId) {
              moveDrag(touch.clientX, touch.clientY, touch.identifier, event)
              return
            }
          }
        },
        { passive: false }
      )
      global.addEventListener('touchend', function (event) {
        if (!dragState || dragState.inputId === 'mouse') return
        for (var index = 0; index < event.changedTouches.length; index++) {
          if (event.changedTouches[index].identifier === dragState.inputId) {
            finishDrag(dragState.inputId, event, false)
            return
          }
        }
      })
      global.addEventListener('touchcancel', function (event) {
        if (!dragState || dragState.inputId === 'mouse') return
        finishDrag(dragState.inputId, event, true)
      })
    }

    button.addEventListener('click', function (event) {
      if (Date.now() < ignoreClickUntil) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      onActivate()
    })

    restoreOpenButtonPosition(button)
    global.addEventListener('resize', function () {
      if (!button.style.left || !button.style.top) return
      var rect = button.getBoundingClientRect()
      placeOpenButton(button, rect.left, rect.top, true)
    })
  }

  function buildUi() {
    var openButton = document.createElement('button')
    openButton.type = 'button'
    openButton.className = 'account-login-open'
    openButton.textContent = '功能'
    openButton.setAttribute('aria-label', '打开功能面板')
    openButton.setAttribute('aria-expanded', 'false')
    panel = document.createElement('section')
    panel.className = 'account-login-panel'
    panel.hidden = true
    panel.setAttribute('aria-label', '功能面板')
    panel.innerHTML =
      '<header class="account-login-header"><div><strong>功能</strong></div><button type="button" class="account-login-close" aria-label="关闭">×</button></header>' +
      '<div class="account-login-tabs" role="tablist"><button type="button" role="tab" data-login-tab="bin" class="is-active" aria-selected="true">BIN 登录</button><button type="button" role="tab" data-login-tab="qr" aria-selected="false" hidden>扫码登录</button><button type="button" role="tab" data-login-tab="scripts" aria-selected="false" hidden>脚本</button></div>' +
      '<div class="account-login-page" data-login-page="bin"><input class="account-login-file" type="file" accept=".bin,application/octet-stream" /><button type="button" class="account-login-primary account-login-import">导入并登录 BIN</button><p class="account-login-summary"></p><div class="account-login-bin-toolbar"><strong>已保存账号</strong><button type="button" class="account-login-clear-bins" hidden>清空全部</button></div><div class="account-login-bin-list"></div><p class="account-login-note account-login-storage-warning">BIN 已保存</p></div>' +
      '<div class="account-login-page" data-login-page="qr" hidden><div class="account-login-qr"><img alt="官方登录二维码" hidden /><div class="account-login-qr-placeholder">等待官方扫码服务</div></div><button type="button" class="account-login-primary account-login-qr-start" disabled>获取二维码</button><button type="button" class="account-login-secondary account-login-qr-cancel" hidden>取消扫码</button><div class="account-login-server-picker" hidden><fieldset><legend>选择已有角色（可多选）</legend><div class="account-login-server-select" role="group" aria-label="已有角色"></div></fieldset><button type="button" class="account-login-primary account-login-server-confirm">添加到 BIN 登录</button></div><p class="account-login-note">列表只显示该微信账号实际拥有的角色；勾选后只保存到 BIN 登录账号列表，不会自动登录或切换角色。</p></div>' +
      '<div class="account-login-page" data-login-page="scripts" hidden><div class="account-login-script-host"><p class="account-login-empty">雪花脚本工具正在加载…</p></div></div>' +
      '<output class="account-login-status">等待登录数据</output>'
    document.body.appendChild(openButton)
    document.body.appendChild(panel)
    statusNode = panel.querySelector('.account-login-status')
    fileInput = panel.querySelector('.account-login-file')
    binSummary = panel.querySelector('.account-login-summary')
    binListNode = panel.querySelector('.account-login-bin-list')
    clearBinsButton = panel.querySelector('.account-login-clear-bins')
    qrImage = panel.querySelector('.account-login-qr img')
    qrPlaceholder = panel.querySelector('.account-login-qr-placeholder')
    qrStartButton = panel.querySelector('.account-login-qr-start')
    qrCancelButton = panel.querySelector('.account-login-qr-cancel')
    serverPicker = panel.querySelector('.account-login-server-picker')
    serverSelect = panel.querySelector('.account-login-server-select')
    serverConfirmButton = panel.querySelector('.account-login-server-confirm')
    makeOpenButtonDraggable(openButton, function () {
      panel.hidden = !panel.hidden
      openButton.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true')
    })
    panel.querySelector('.account-login-close').addEventListener('click', function () {
      panel.hidden = true
      openButton.setAttribute('aria-expanded', 'false')
    })
    panel.querySelector('.account-login-import').addEventListener('click', function () {
      fileInput.click()
    })
    fileInput.addEventListener('change', function () {
      importBin(fileInput.files && fileInput.files[0])
    })
    clearBinsButton.addEventListener('click', function () {
      try {
        clearStoredBins()
      } catch (error) {
        setStatus(safeString(error.message || error), 'error')
      }
    })
    qrStartButton.addEventListener('click', startQr)
    qrCancelButton.addEventListener('click', function () {
      cancelQr(true)
      setStatus('已取消扫码', '')
    })
    serverConfirmButton.addEventListener('click', confirmServerSelection)
    Array.prototype.forEach.call(panel.querySelectorAll('[data-login-tab]'), function (tab) {
      tab.addEventListener('click', function () {
        showTab(tab.getAttribute('data-login-tab'))
      })
    })
    renderBinList()
    updateBinSummary()
    // Standalone BIN login; no legacy script manager.
  }

  buildUi()
  var restoredBin = loadStoredBins()
  renderBinList()
  updateBinSummary()
  if (restoredBin && restoredBin.loadError) {
    setStatus('读取已保存账号失败：' + restoredBin.loadError, 'error')
  } else if (restoredBin) {
    setStatus('已恢复 ' + restoredBin.name + '，将在游戏认证时自动登录', 'ready')
  }
  hookLoginService()
  var serviceTimer = global.setInterval(function () {
    if (hookLoginService()) global.clearInterval(serviceTimer)
  }, 500)
  if (
    restoredBin &&
    !restoredBin.loadError &&
    restoredBin.source === 'bin' &&
    !hasCredentialRoleLabel(restoredBin.credential)
  ) {
    loadStoredBinRole(restoredBin.id, restoredBin.credential).catch(function () {})
  }

  global.AuditedAccountLogin = Object.freeze({
    installHooks: hookLoginService,
    registerQrProvider: registerQrProvider,
    prepareCredential: function (payload) {
      prepareCredential(payload, 'external')
    },
    cancel: function () {
      credential = null
      credentialSource = ''
      selectedBinId = ''
      try {
        writeStoredBins()
      } catch (error) {}
      cancelQr(true)
      renderBinList()
      updateBinSummary()
      setStatus('已取消当前账号选择，已保存列表仍保留', '')
    }
  })

  if (global.__ACCOUNT_QR_PROVIDER__) {
    try {
      registerQrProvider(global.__ACCOUNT_QR_PROVIDER__)
    } catch (error) {
      setStatus(safeString(error.message || error), 'error')
    }
  }
})(window)
