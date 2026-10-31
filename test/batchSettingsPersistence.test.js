import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const page = fs.readFileSync(new URL('../src/views/BatchDailyTasks.vue', import.meta.url), 'utf8').split('<script setup>')[1].split('</script>')[0];
const ast = ts.createSourceFile('batch.js', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function load(name, globals) {
  const statement = ast.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === name));
  const context = vm.createContext(globals);
  vm.runInContext(statement.getText(ast) + '\nglobalThis.subject = ' + name, context);
  return context.subject;
}
test('account settings success waits for cloud persistence; a rejected write keeps the dialog open', async () => {
  let resolve, successes = 0, errors = 0;
  const globals = { currentSettingsTokenId: {value:'fixture'}, currentSettingsTokenName:{value:'fixture'}, currentSettings:{openBox:false},
    showSettingsModal:{value:true}, message:{success(){successes++;},error(){errors++;}}, settingsApi:{set:()=>new Promise(r=>{resolve=r;})} };
  const save = load('saveSettings',globals);
  const pending=save();
  assert.equal(successes,0);assert.equal(globals.showSettingsModal.value,true);
  resolve();await pending;
  assert.equal(successes,1);assert.equal(globals.showSettingsModal.value,false);
  globals.showSettingsModal.value=true;
  globals.settingsApi.set=async()=>{throw Error('offline');};
  await save();
  assert.equal(errors,1);assert.equal(successes,1);assert.equal(globals.showSettingsModal.value,true);
});
test('template application reports partial persistence without claiming all accounts succeeded', async () => {
  const saved=[],messages=[];
  const globals={selectedTemplateId:{value:'t'},selectedTokensForApply:{value:['a','b']},showApplyTemplateModal:{value:true},
    loadTaskTemplates:async()=>[{id:'t',settings:{openBox:false}}],settingsApi:{set:async(key,value)=>{if(key.endsWith(':b'))throw Error('offline');saved.push({key,value});}},
    message:{success:m=>messages.push(m),error:m=>messages.push(m)}};
  await load('applyTemplate',globals)();
  assert.equal(saved.length,1);assert.equal(saved[0].value.templateId,'t');
  assert.match(messages[0],/已应用 1 个账号/);assert.equal(globals.showApplyTemplateModal.value,true);
});
test('black-market config failure does not close the editor or claim success', async () => {
  const globals={normalizeBlackMarketPurchaseList:x=>x,blackMarketPurchaseList:{value:[{itemId:2001}]},batchSettings:{},
    saveBatchSettings:async()=>false,showBlackMarketPurchaseModal:{value:true},message:{error(){assert.fail('valid config');}}};
  await load('saveBlackMarketPurchaseConfig',globals)();
  assert.equal(globals.showBlackMarketPurchaseModal.value,true);
});
