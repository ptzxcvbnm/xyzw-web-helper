import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { scheduledTaskRoutes } from '../routes/scheduledTasks.js';
import { createServerDeps } from '../lib/serverDeps.js';
import { createTasksStore } from '../lib/batch/tasksStore.js';
import { CommandRegistry } from '../lib/commandRegistryBase.js';
import { registerDefaultCommands } from '../lib/commandRegistry.js';
import { XyzwWebSocketClient } from '../lib/xyzwWebSocket.js';
import { GameManager } from '../lib/gameManager.js';
import { tokenRoutes } from '../routes/token.js';

async function serve(t, router) {
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.userId='alice';next();});app.use(router);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return 'http://127.0.0.1:'+server.address().port;
}
const post=(base,url,body)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

test('a service restart clears stale running status while retaining the schedule',()=>{
  const task={id:'restart-fixture',enabled:false,lastResult:{running:true}};
  const db={getAllUsers:()=>[{id:'alice'}],getAllScheduledTasks:()=>[task],updateScheduledTask:(_id,patch)=>Object.assign(task,patch)};
  scheduledTaskRoutes(db,{});
  assert.equal(task.lastResult.running,false);
  assert.match(task.lastResult.error,/重启/);
  assert.equal(task.enabled,false);
});

test('scheduled manual runs return immediately, continue in backend, reject duplicate and foreign actions',async t=>{
  const task={id:'mine',name:'mock',cron:'0 0 * * *',tokenIds:['token-a'],settings:{selectedTasks:['startBatch']},enabled:false};
  const foreign={...task,id:'foreign'};
  let release,started=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const db={
    getAllUsers:()=>[],getAllTokens:()=>[{id:'token-a'}],
    getAllScheduledTasks:()=>[task],
    updateScheduledTask:(id,patch)=>{assert.equal(id,'mine');Object.assign(task,patch);},
    addScheduledTask:()=>assert.fail('invalid task must not be saved'),
    removeScheduledTask:()=>assert.fail('foreign task must not be deleted'),
  };
  const base=await serve(t,scheduledTaskRoutes(db,{}, {executor:async()=>{started++;await gate;return{done:true};}}));
  const response=await post(base,'/mine/run',{});
  assert.equal(response.status,202);
  assert.equal(started,1);
  assert.equal(task.lastResult.running,true);
  assert.equal((await post(base,'/mine/run',{})).status,409);
  assert.equal((await post(base,'/foreign/run',{})).status,404);
  assert.equal((await fetch(base+'/foreign',{method:'DELETE'})).status,404);
  assert.equal((await fetch(base+'/foreign',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'})).status,404);
  assert.equal((await post(base,'/',{cron:'0 0 * * *',tokenIds:['other-account'],enabled:false})).status,400);
  assert.equal((await post(base,'/',{cron:'0 0 * * *',tokenIds:['token-a'],settings:{selectedTasks:['batchApplyLegion']},enabled:false})).status,400);
  release();
  for(let i=0;i<20&&task.lastResult.running;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(task.lastResult.success,true);
  assert.deepEqual(task.lastResult.summary,{done:true});
});

test('server deps retain per-user settings, source client identity and single-attempt transport',async()=>{
  const calls=[],client={serverTime:1700000000000};
  const db={
    getAllTokens:()=>[{id:'mine',name:'fixture'}],
    getKV:key=>key==='batchSettings'?{cdkCodes:'A B',weirdTowerMaxClimb:321,maxActive:2}:{arenaEnable:false,blackMarketPurchaseList:[1,2]},
  };
  const gm={gameData:new Map(),connections:new Map([['mine',{client}]]),
    sendMessageWithPromise:async(...args)=>{calls.push(args);return{role:{}};}};
  const deps=createServerDeps(gm,db,'alice',{tokenIds:['mine']});
  assert.equal(deps.batchSettings.cdkCodes,'A B');
  assert.equal(deps.weirdTowerMaxClimb.value,321);
  assert.equal(deps.tokenStore.wsConnections.mine.client,client);
  assert.equal((await deps.loadSettings('mine')).arenaEnable,false);
  assert.deepEqual((await deps.loadSettings('mine')).blackMarketPurchaseList,[1,2]);
  await deps.tokenStore.sendMessageWithPromise('mine','role_getroleinfo',{},1000);
  assert.deepEqual(calls[0][4],{retryOnTimeout:false});
  assert.throws(()=>createServerDeps(gm,db,'alice',{tokenIds:['foreign']}),/无权访问/);
});

test('black market sync reads back the target and avoids a second write when unchanged',async()=>{
  let list=[],writes=0,reads=0;
  const statuses={value:{}};
  const deps={
    selectedTokens:{value:['mine']},tokens:{value:[{id:'mine',name:'fixture'}]},
    tokenStatus:statuses,isRunning:{value:false},shouldStop:{value:false},
    ensureConnection:async()=>{},releaseConnectionSlot(){},connectionQueue:{active:0},
    batchSettings:{blackMarketPurchaseList:[{itemId:2002,discount:8}]},
    tokenStore:{closeWebSocketConnection(){},async sendMessageWithPromise(_id,cmd,params){
      if(cmd==='store_getpurchase'){reads++;return{purchaseCnt:2,purchaseItemList:list};}
      assert.equal(cmd,'store_setpurchase');writes++;assert.equal(params.purchaseCnt,2);list=params.purchaseItemList;return{};
    }},
    addLog(){},message:{success(){},warning(){},error(){}},currentRunningTokenId:{value:null},
    delayConfig:{action:0},
  };
  const tasks=createTasksStore(deps);
  await tasks.store_syncpurchaseconfig();
  assert.equal(writes,1);assert.equal(reads,2);assert.equal(statuses.value.mine,'completed');
  await tasks.store_syncpurchaseconfig();
  assert.equal(writes,1);assert.equal(reads,3);
});

test('new protocol commands can be built and carry the supplied parameters',()=>{
  const registry=registerDefaultCommands(new CommandRegistry());
  for(const cmd of ['system_claimcdkreward','store_setpurchase','club_attackmonster','activity_lottery','saltcup26_placebet','apex_guess','legion_applyjoin']){
    const packet=registry.build(cmd,1,2,{fixture:7});
    assert.equal(packet.cmd,cmd);assert.deepEqual(packet.body,{fixture:7});
  }
});

test('transport tracks monotonic server time and rejects stale response IDs',()=>{
  const client=new XyzwWebSocketClient({url:'wss://fixture-batch',utils:{}});
  client._updateAckFromPacket({_raw:{seq:1,time:1700000000500}});
  client._updateAckFromPacket({_raw:{seq:2,time:1700000000000}});
  assert.equal(client.serverTime,1700000000500);
  let completed=false;
  client.promises[1]={resolve(){completed=true;},reject(){assert.fail();},cmd:'role_getroleinfo',timer:null};
  client._handlePromiseResponse({resp:999,cmd:'role_getroleinforesp',code:0,body:{}});
  assert.equal(completed,false);assert.ok(client.promises[1]);
  client._handlePromiseResponse({resp:1,cmd:'role_getroleinforesp',code:0,body:{}});
  assert.equal(completed,true);
});

test('single-attempt game calls do not reconnect/replay on timeout or accept replaced sessions',async()=>{
  const gm=new GameManager({}, {log(){},broadcast(){}});
  const conn={status:'connected',client:{async sendWithPromise(){throw new Error('请求超时');}}};
  gm.connections.set('mine',conn);
  gm.disconnect=()=>assert.fail('must not reconnect');
  await assert.rejects(gm.sendMessageWithPromise('mine','system_signinreward',{},1000,{retryOnTimeout:false}),/请求超时/);
  conn.client.sendWithPromise=async()=>{gm.connections.set('mine',{status:'connected',client:{}});return{};};
  await assert.rejects(gm.sendMessageWithPromise('mine','system_signinreward',{},1000,{retryOnTimeout:false}),/会话已变化/);
});

test('token command API scopes ownership and returns only safe connection metadata',async t=>{
  const calls=[];
  const db={getToken:(id,user)=>id==='mine'&&user==='alice'?{id}:null};
  const gm={
    async sendMessageWithPromise(...args){calls.push(args);return{role:{}};},
    getConnectionMetadata:()=>({sessionId:'fixture-session',serverTime:1700000000000,status:'connected'}),
  };
  const base=await serve(t,tokenRoutes(db,gm));
  assert.equal((await post(base,'/foreign/send',{cmd:'role_getroleinfo'})).status,404);
  assert.equal(calls.length,0);
  const result=await post(base,'/mine/send',{cmd:'role_getroleinfo',retryOnTimeout:false});
  assert.equal(result.status,200);
  const body=await result.json();
  assert.equal(body.connection.sessionId,'fixture-session');
  assert.deepEqual(calls[0][4],{retryOnTimeout:false});
});
