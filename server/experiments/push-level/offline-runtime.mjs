import vm from 'node:vm';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const assetLock = JSON.parse(await readFile(new URL('asset-lock.json', import.meta.url), 'utf8'));

const configuredAssetDirectory = process.env.XYZW_BATTLE_ASSETS
  || (process.env.DATA_DIR ? resolve(process.env.DATA_DIR, 'battle-assets') : null);

export const assetDirectory = configuredAssetDirectory
  ? pathToFileURL(resolve(configuredAssetDirectory) + sep)
  : new URL('../../../tmp/xki-analysis/', import.meta.url);

function extractBundleRegistration(text, bundle) {
  const assignments = [...text.matchAll(/window(?:\.__require|\[[^\]\r\n]{1,100}\])=function/g)];
  const separator = text.lastIndexOf('},{},[');
  const invocationEnd = text.lastIndexOf(']);');
  if (assignments.length !== 1 || separator < 0 || invocationEnd < separator) {
    throw new Error(`Unexpected module bundle wrapper in ${bundle}`);
  }
  const assignment = assignments[0];
  const functionStart = assignment.index + assignment[0].lastIndexOf('function');
  const argumentsStart = text.indexOf('}({', functionStart);
  if (argumentsStart < 0 || argumentsStart >= separator) {
    throw new Error(`Could not locate module bundle arguments in ${bundle}`);
  }
  const modules = text.slice(argumentsStart + 2, separator + 1);
  const entries = text.slice(separator + 5, invocationEnd + 1);
  return {
    registration: text.slice(0, functionStart)
      + `__register(${modules}, ${JSON.stringify(bundle)})`
      + text.slice(invocationEnd + 2),
    entries,
  };
}

export async function createOfflineRuntime(directory = assetDirectory) {
  async function readAsset(path) {
    const bytes = await readFile(new URL(path, directory));
    const locked = assetLock.files.find(file => file.path === path);
    if (!locked || createHash('sha256').update(bytes).digest('hex') !== locked.sha256) {
      throw new Error(`Asset version mismatch: ${path}`);
    }
    return bytes.toString('utf8');
  }
  const factories = new Map();
  const aliases = new Map();
  const cache = new Map();
  const trace = [];
  function load(name, origin) {
    const descriptor = origin && factories.get(origin);
    const mapped = descriptor?.deps[name];
    const key = mapped != null && factories.has(`${descriptor.bundle}:${mapped}`)
      ? `${descriptor.bundle}:${mapped}`
      : aliases.get(name) || aliases.get(name.split('/').at(-1));
    if (!key) throw new Error(`Missing module ${name} from ${origin}; chain: ${trace.join(' -> ')}`);
    if (cache.has(key)) return cache.get(key).exports;
    const entry = factories.get(key);
    const module = { exports: {} };
    cache.set(key, module);
    trace.push(key);
    try { entry.factory.call(module.exports, dependency => load(dependency, key), module, module.exports); }
    catch (error) { cache.delete(key); throw error; }
    finally { trace.pop(); }
    return module.exports;
  }
  const context = vm.createContext({ console, TextDecoder, TextEncoder });
  context.__register = (modules, bundle) => {
    inventories[bundle] = Object.keys(modules);
    for (const [id, [factory, deps]] of Object.entries(modules)) {
      const key = `${bundle}:${id}`;
      factories.set(key, {factory, deps, bundle});
      if (!/^\d+$/.test(id)) aliases.set(id, key);
    }
    for (const [, deps] of Object.values(modules)) for (const [name, id] of Object.entries(deps)) {
      if (!name.startsWith('.') && id != null && factories.has(`${bundle}:${id}`)) aliases.set(name, `${bundle}:${id}`);
    }
    return name => load(name);
  };
  vm.runInContext(`
    var window = globalThis, self = globalThis, global = globalThis;
    var CC_EDITOR = false, CC_DEV = false, CC_DEBUG = false, CC_JSB = false;
    var cc = { _RF: { push(){}, pop(){} }, sys: { isNative:false, isBrowser:false, os:'Node' } };
    var setTimeout = () => { throw new Error('Timers unavailable in offline runtime'); };
    var setInterval = setTimeout;
    var clearTimeout = () => {}, clearInterval = () => {};
    var performance = {now: () => Date.now()};
  `, context);
  const inventories = {};
  const startupEntries = {};
  for (const bundle of ['launcher', 'TEST_REMOTE_MODULE', 'game']) {
    const text = await readAsset(`${bundle}.js`);
    const extracted = extractBundleRegistration(text, bundle);
    // Only register factories. Never run launcher/UI/network startup entrypoints.
    vm.runInContext(extracted.registration, context, {filename: `${bundle}.js`, timeout: 10000});
    if (bundle === 'TEST_REMOTE_MODULE') startupEntries[bundle] = vm.runInContext(extracted.entries, context, {timeout:1000});
  }
  await writeFile(new URL('module-inventory.json', directory), JSON.stringify(inventories, null, 2));
  const runtime = { context, loaded: () => [...cache.keys()], run(code, timeout = 20000) { return vm.runInContext(code, context, { timeout, filename:'offline-probe.js' }); } };
  runtime.initialize = async () => {
    const configuration = {};
    for (const name of ['config', 'config_ap', 'language', 'levelcoef', 'level', 'tower', 'season_level', 'season_tower']) {
      const asset = JSON.parse(await readAsset(`config/${name}.json`));
      if (asset[3]?.[0]?.[0] !== 'cc.JsonAsset' || asset[5]?.[0]?.[1] !== name) throw new Error(`Unexpected config serialization: ${name}`);
      Object.assign(configuration, asset[5][0][2]);
    }
    context.__configPayload = configuration;
    load('launcher-server');
    // Commands and effects self-register when their factories are loaded.
    for (const name of startupEntries.TEST_REMOTE_MODULE.filter(name => /^(cmd-|effect-)/.test(name))) load(name);
    const result = runtime.run(`__require('MapExt'); var configs = __require('Configs'); configs.decodeConfig(__configPayload); delete __configPayload; var factory = new (__require('launcher-server').ServerBattleLauncher)(); factory.initialize(); ({configTables:Object.keys(configs).length, battleTypes:factory.prototypeFactory.size})`);
    runtime.run(`Object.assign(__require('battle-const').BattleConst, ${JSON.stringify({BATTLE_VERSION:assetLock.battleVersion, CONFIG_COMMIT_ID:assetLock.configCommit, ENGINE_VERSION:assetLock.engineVersion})})`);
    return {...result, configCommit:configuration.COMMIT_ID};
  };
  return runtime;
}

if (process.argv[1]?.endsWith('offline-runtime.mjs')) {
  const runtime = await createOfflineRuntime();
  try {
    console.log(await runtime.initialize());
  } catch (error) {
    console.error(error.stack?.split('\n').slice(0, 20).map(line => line.length > 500 ? line.slice(0, 500) + '...' : line).join('\n'));
    process.exitCode = 1;
  }
}
