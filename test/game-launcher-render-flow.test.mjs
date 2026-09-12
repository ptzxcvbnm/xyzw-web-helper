import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(
  new URL('../public/game-launcher/src/platform-compat.js', import.meta.url),
  'utf8',
)

function setup() {
  const warnings = []
  const renderPrototype = {
    _updateRenderData() {
      throw new Error('engine handler should be replaced')
    },
  }
  const RenderFlow = function () {}
  RenderFlow.prototype = renderPrototype
  RenderFlow.UPDATE_RENDER_DATA = 4
  const window = {
    cc: {
      RenderFlow,
      dynamicAtlasManager: {
        enabled: true,
      },
      assetManager: {
        cacheManager: {},
        loadAny() {},
        loadBundle() {},
      },
    },
    navigator: {},
    setTimeout,
  }
  const console = {
    log() {},
    warn(message) {
      warnings.push(message)
    },
  }
  vm.runInContext(source, vm.createContext({ window, console, setTimeout }))
  window.installAuditedCocosGuards()
  return { window, renderPrototype, warnings }
}

test('disables the dynamic atlas before remote scenes can pack persistent UI sprites', () => {
  const { window } = setup()
  assert.equal(window.cc.dynamicAtlasManager.enabled, false)
})

test('updates ready render data, clears the flag and continues the flow', () => {
  const { renderPrototype } = setup()
  let updates = 0
  let continued = 0
  const component = {
    _assembler: {
      updateRenderData(received) {
        assert.equal(received, component)
        updates++
      },
    },
  }
  const node = { _renderComponent: component, _renderFlag: 5 }
  renderPrototype._updateRenderData.call(
    { _next: { _func(received) { assert.equal(received, node); continued++ } } },
    node,
  )
  assert.equal(updates, 1)
  assert.equal(node._renderFlag, 1)
  assert.equal(continued, 1)
})

test('keeps incomplete nodes dirty while allowing following UI nodes to render', () => {
  const { renderPrototype } = setup()
  let continued = 0
  const node = { _renderComponent: {}, _renderFlag: 5 }
  renderPrototype._updateRenderData.call(
    { _next: { _func() { continued++ } } },
    node,
  )
  assert.equal(node._renderFlag, 5)
  assert.equal(continued, 1)
})

test('contains assembler failures, keeps the retry flag and continues once', () => {
  const { renderPrototype, warnings } = setup()
  let continued = 0
  const node = {
    _renderComponent: {
      _assembler: {
        updateRenderData() {
          throw new Error('texture not ready')
        },
      },
    },
    _renderFlag: 5,
  }
  const flow = { _next: { _func() { continued++ } } }
  renderPrototype._updateRenderData.call(flow, node)
  renderPrototype._updateRenderData.call(flow, node)
  assert.equal(node._renderFlag, 5)
  assert.equal(continued, 2)
  assert.equal(warnings.filter(message => message.includes('deferred')).length, 1)
})

test('does not allow remote bundles to replace the safe render handler', () => {
  const { renderPrototype } = setup()
  const installed = renderPrototype._updateRenderData
  renderPrototype._updateRenderData = function () {}
  assert.equal(renderPrototype._updateRenderData, installed)
})
