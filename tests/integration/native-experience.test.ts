import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWebServer } from "../../src/web/server.js";
import { application } from "../../src/cli/session-application.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { parseNativeOptions } from "../../src/contracts/session.js";

async function fixture(t: test.TestContext, scenario = "native-experience") {
  const root = await mkdtemp(join(tmpdir(), "native-experience-")), home = join(root,"home"), workspace=join(root,"workspace"), peer=join(root,"original-peer.mjs"), trace=join(root,"trace"), manifest=join(root,"catalog.json");
  await mkdir(home); await mkdir(workspace); await copyFile(resolve("tests/fixtures/control-peer.mjs"),peer);
  const source={repository:"fixture",revision:"native-experience",upstreamId:"fixture",url:"https://example.invalid/native"};
  const definitions=["alpha","bravo"].map(id=>({id:"native-"+id,name:id,aliases:[],binaryNames:[],configHints:[],controls:[{id:"native-"+id,protocol:"acp-v1",executableNames:["fixture"],args:[peer,"acp-v1",scenario],env:{FIXTURE_TRACE:trace},package:null,distribution:null,requiredExecutables:[],source}]}));
  await writeFile(manifest,JSON.stringify({version:2,definitions,overrides:Object.fromEntries(definitions.map(row=>[row.controls[0]!.id,{executable:process.execPath}]))}));
  const config=await prepareConfiguration({workspace,manifestPath:manifest,pathOnly:true}), native=captureNativeEnvironment({HOME:home,PATH:process.env.PATH});
  const server=await startWebServer({root:join(root,"data"),configuration:config,application:(data,publish)=>application(data,publish,{installations:"any",nativeEnvironment:native,management:{installationMode:"private-fixture"},workspaceLockRoot:join(root,"locks")})});
  t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true});});
  const url=new URL(server.url),origin=url.origin;
  const boot=await fetch(origin+"/api/v1/auth/bootstrap",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({token:new URLSearchParams(url.hash.slice(1)).get("token")})});
  const auth=await boot.json() as {csrfToken:string};
  const headers={Cookie:boot.headers.get("set-cookie")!.split(";",1)[0]!,Origin:origin,"Content-Type":"application/json","X-CSRF-Token":auth.csrfToken};
  const call=async(path:string,body?:unknown)=>{const response=await fetch(origin+"/api/v1"+path,{method:body===undefined?"GET":"POST",headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,value:await response.json() as Record<string,unknown>};};
  const wire=async()=>{try{return (await readFile(trace,"utf8")).trim().split("\n").map(line=>JSON.parse(line) as Record<string,unknown>);}catch(error){if(error!==null&&typeof error==="object"&&"code"in error&&error.code==="ENOENT")return [];throw error;}};
  const until=async(path:string,predicate:(row:Record<string,unknown>)=>boolean)=>{const deadline=Date.now()+10000;for(;;){const {value}=await call(path);if(predicate(value))return value;if(Date.now()>deadline)throw Error("native fixture did not reach its required public state");await new Promise<void>(done=>setTimeout(done,10));}};
  return {root,home,workspace,peer,trace,call,wire,until};
}

test("native enum parsing rejects arbitrary objects, unsafe keys, oversized inputs and sorts valid keys",()=>{
  assert.deepEqual(parseNativeOptions({z:"high",a:"off"}),{a:"off",z:"high"});
  for(const input of [null,[],{effort:3},{effort:""},{effort:"a\nb"},JSON.parse('{"__proto__":"high"}'),Object.fromEntries(Array.from({length:65},(_,i)=>["k"+i,"low"]))])assert.throws(()=>parseNativeOptions(input));
});

test("formal native catalog caches successful results, refreshes explicitly and invalidates a changed installed entry",{timeout:20000},async t=>{
  const f=await fixture(t), path="/harnesses/native-alpha/models?controlId=native-alpha&workspace="+encodeURIComponent(f.workspace);
  assert.equal((await f.call(path)).status,200);const first=(await f.wire()).filter(row=>row.method==="initialize").length;
  assert.equal((await f.call(path)).status,200);assert.equal((await f.wire()).filter(row=>row.method==="initialize").length,first);
  assert.equal((await f.call(path+"&refresh=1")).status,200);assert.equal((await f.wire()).filter(row=>row.method==="initialize").length,first+1);
  await writeFile(f.peer,(await readFile(f.peer,"utf8"))+"\n// changed native installation identity\n");
  assert.equal((await f.call(path)).status,200);assert.equal((await f.wire()).filter(row=>row.method==="initialize").length,first+2);
  assert.equal((await f.call(path+"&refresh=false")).status,400);
});

test("formal switches create no native process, original settings reach ACP and thinking/tools stay committed",{timeout:20000},async t=>{
  const f=await fixture(t);const created=await f.call("/sessions",{selection:{harnessId:"native-alpha"},commandId:"create"}),id=String(created.value.id);
  assert.equal(created.status,201);assert.equal((await f.wire()).length,0);
  const options={"native-thinking":"max","native-fast":"on"};
  assert.equal((await f.call(`/sessions/${id}/switches`,{selection:{harnessId:"native-bravo",nativeModel:"native-model-b",nativeOptions:options},commandId:"switch"})).status,202);
  await f.until(`/sessions/${id}`,row=>row.pendingSwitchId===null);assert.equal((await f.wire()).length,0,"selector must not perform native initialize/open/close");
  assert.equal((await f.call(`/sessions/${id}/messages`,{text:"native settings reply",commandId:"send"})).status,202);
  const finished=await f.until(`/sessions/${id}`,row=>Array.isArray(row.runs)&&(row.runs.at(-1) as {status:string})?.status==="completed");
  const run=(finished.runs as {thinking:string;tools:{status:string}[];selection:{nativeOptions:unknown}}[]).at(-1)!;
  assert.equal(run.thinking,"Observed fixture thinking");assert.equal(run.tools[0]!.status,"completed");assert.deepEqual(run.selection.nativeOptions,options);
  const wire=await f.wire();for(const [configId,value]of Object.entries(options))assert.ok(wire.some(row=>row.method==="session/set_config_option"&&(row.params as Record<string,unknown>).configId===configId&&(row.params as Record<string,unknown>).value===value));
  await f.call(`/sessions/${id}/messages`,{text:"/native-help fixture",commandId:"native-command"});
  await f.until(`/sessions/${id}`,row=>Array.isArray(row.runs)&&row.runs.length===2&&(row.runs.at(-1) as {status:string}).status==="completed");
  const commandWire=await f.wire(), nativePrompt=commandWire.filter(row=>row.method==="session/prompt").at(-1)!;
  assert.deepEqual((nativePrompt.params as {prompt:unknown}).prompt,[{type:"text",text:"/native-help fixture"}]);
  const commandEvents=await f.call(`/sessions/${id}/events?afterSeq=0&limit=100`);
  assert.ok((commandEvents.value.events as {type:string;data:{publicContextInjected?:boolean}}[]).some(event=>event.type==="run.native_command"&&event.data.publicContextInjected===false));
  assert.equal((await f.call(`/sessions/${id}/switches`,{selection:{harnessId:"native-alpha",nativeOptions:{"native-thinking":"invented"}},commandId:"bad-option"})).status,202);
  await f.until(`/sessions/${id}`,row=>row.pendingSwitchId===null);await f.call(`/sessions/${id}/messages`,{text:"invalid native choice",commandId:"bad-input"});
  const failed=await f.until(`/sessions/${id}`,row=>Array.isArray(row.runs)&&(row.runs.at(-1) as {status:string})?.status==="failed");
  assert.equal((failed.runs as {error:{code:string}}[]).at(-1)!.error.code,"NATIVE_OPTION_UNAVAILABLE");assert.equal(failed.status,"open");
});

test("native approvals round-trip actual option IDs after durable decisions and replay without another response",{timeout:20000},async t=>{
  const f=await fixture(t,"permission"),created=await f.call("/sessions",{selection:{harnessId:"native-alpha"},commandId:"create"}),id=String(created.value.id);
  await f.call(`/sessions/${id}/messages`,{text:"fixture approval",commandId:"send"});
  const waiting=await f.until(`/sessions/${id}`,row=>Array.isArray(row.permissions)&&row.permissions.length===1),permission=(waiting.permissions as {id:string;options:{id:string}[]}[])[0]!;
  assert.ok(permission.options.some(option=>option.id==="allow"));
  // The approval shows what it would allow: the proposed diff from the request's tool call.
  const shown=permission as unknown as {title:string;detail?:string};assert.equal(shown.title,"Edit notes.txt");assert.match(String(shown.detail),/-bravo\n\+delta/u);
  assert.equal((await f.call(`/sessions/${id}/permissions/${permission.id}`,{optionId:"fabricated",commandId:"bad-decision"})).status,409);
  assert.equal((await f.wire()).filter(row=>row.id==="permission-1"&&row.result!==undefined).length,0);
  const input={optionId:"allow",commandId:"decision"};assert.equal((await f.call(`/sessions/${id}/permissions/${permission.id}`,input)).status,200);
  await f.until(`/sessions/${id}`,row=>row.activeRunId===null);
  const replay=await f.call(`/sessions/${id}/permissions/${permission.id}`,input);assert.equal(replay.status,200);assert.equal(replay.value.replayed,true);
  assert.equal((await f.call(`/sessions/${id}/permissions/${permission.id}`,{optionId:"reject",commandId:"decision"})).status,409);
  assert.equal((await f.wire()).filter(row=>row.id==="permission-1"&&row.result!==undefined).length,1);
  const page=await f.call(`/sessions/${id}/events?afterSeq=0&limit=100`),events=page.value.events as {type:string;seq:number}[];
  assert.ok(events.find(event=>event.type==="permission.decided")!.seq<events.find(event=>event.type==="permission.submitted")!.seq);
});

test("native CLI helper owns exit, bounded output, cancellation and refuses malformed UTF-8",{timeout:10000},async t=>{
  const {nativeCommand}=await import("../../src/infrastructure/control/native-command.js"),root=await mkdtemp(join(tmpdir(),"native-command-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const launch={protocol:"acp-v1" as const,executable:process.execPath,args:[],env:{}},options={cwd:root,env:{},requestTimeoutMs:1000,runTimeoutMs:1000,maxFrameBytes:1024,maxDiagnosticBytes:1024,closeGraceMs:100};
  assert.equal(await nativeCommand(launch,["-e","process.stdout.write('native')"],options,new AbortController().signal),"native");
  await assert.rejects(nativeCommand(launch,["-e","process.stdout.write(Buffer.from([255]))"],options,new AbortController().signal),error=>error!==null&&typeof error==="object"&&"code"in error&&error.code==="INVALID_NATIVE_METADATA");
  await assert.rejects(nativeCommand(launch,["-e","process.stdout.write('x'.repeat(2048));setInterval(()=>{},1000)"],options,new AbortController().signal),error=>error!==null&&typeof error==="object"&&"code"in error&&error.code==="OUTPUT_LIMIT");
  const abort=new AbortController();abort.abort();await assert.rejects(nativeCommand(launch,["-e","throw Error('must not start')"],options,abort.signal),error=>error!==null&&typeof error==="object"&&"code"in error&&error.code==="CANCELLED");
});

test("Darwin exited-group evidence rejects any live member, malformed inventory and unowned group identities",async()=>{
  const {exitedGroupSnapshotIsQuiescent}=await import("../../src/infrastructure/control/process-group.js");
  assert.equal(exitedGroupSnapshotIsQuiescent(200,"100 S\n201 R\n"),true);assert.equal(exitedGroupSnapshotIsQuiescent(200,"200 Z\n200 Z+\n"),true);
  for(const output of ["","200 S\n","200 Z\n200 R+\n","invalid inventory","200 Z\npartial"])assert.equal(exitedGroupSnapshotIsQuiescent(200,output),false);
  assert.equal(exitedGroupSnapshotIsQuiescent(0,""),false);assert.equal(exitedGroupSnapshotIsQuiescent(1,""),false);
});

test("a setting the native session changed itself is applied as it is on the next Turn and shown, until an explicit switch applies the selection again",{timeout:30000},async t=>{
  const f=await fixture(t,"native-config");
  const created=await f.call("/sessions",{selection:{harnessId:"native-alpha",nativeOptions:{"native-fast":"off"}},commandId:"create"}),id=String(created.value.id);
  assert.equal(created.status,201);
  const send=async(text:string,key:string,count:number)=>{assert.equal((await f.call(`/sessions/${id}/messages`,{text,commandId:key})).status,202);
    return f.until(`/sessions/${id}`,row=>Array.isArray(row.runs)&&row.runs.length===count&&row.activeRunId===null&&(row.runs.at(-1) as {status:string}).status==="completed");};
  const applied=async()=>(await f.wire()).filter(row=>row.method==="session/set_config_option"&&(row.params as {configId:string}).configId==="native-fast").map(row=>(row.params as {value:string}).value);
  type NativeState={status:string;observed?:{model:string|null;options:Record<string,string>};carried?:{model?:string;options?:Record<string,string>}};
  const native=(row:Record<string,unknown>)=>(row.nativeStates as NativeState[])[0]!;
  let view=await send("first turn","one",1);
  assert.deepEqual(native(view),{harnessId:"native-alpha",controlId:"native-alpha",status:"ready",observed:{model:"native-model-a",options:{"native-fast":"off","native-thinking":"low"}}});
  view=await send("/native-fast on","two",2);
  assert.equal(native(view).observed?.options["native-fast"],"on");assert.deepEqual(native(view).carried,{options:{"native-fast":"on"}});
  view=await send("third turn","three",3);
  // A value the restored session already runs is not requested again: only the carried native value is applied.
  assert.deepEqual(await applied(),["on"],"the next Turn applies the native value instead of reverting it");
  const third=(view.runs as {id:string}[])[2]!.id,events:{type:string;data:Record<string,unknown>}[]=[];
  for(let after=0;;){const page=(await f.call(`/sessions/${id}/events?afterSeq=${after}&limit=100`)).value as {events:{type:string;data:Record<string,unknown>}[];nextSeq:number;hasMore:boolean};events.push(...page.events);if(!page.hasMore)break;after=page.nextSeq;}
  assert.deepEqual(events.filter(row=>row.type==="native.config_carried").map(row=>row.data),[{runId:third,options:{"native-fast":"on"}}]);
  assert.deepEqual(native(view).carried,{options:{"native-fast":"on"}},"the native value stays in effect for this selection");
  assert.ok(!JSON.stringify(view).includes("session-fixture"),"the private native session reference stays out of the view");
  // Choosing the same selection again is an explicit switch: the next Turn applies the selection.
  assert.equal((await f.call(`/sessions/${id}/switches`,{selection:{harnessId:"native-alpha",nativeOptions:{"native-fast":"off"}},commandId:"reassert"})).status,202);
  view=await f.until(`/sessions/${id}`,row=>row.pendingSwitchId===null&&row.epoch===2);
  assert.equal(native(view).carried,undefined);
  view=await send("fourth turn","four",4);
  // This fixture restores sessions at their defaults, so the selection (off) is already in effect and the session reports it.
  assert.deepEqual(await applied(),["on"]);assert.equal(native(view).observed?.options["native-fast"],"off");assert.equal(native(view).carried,undefined);
});

test("a native session of the workspace is listed, continued as a conversation and then marked as held by it",{timeout:30000},async t=>{
  const f=await fixture(t,"session-list"),list=(cursor?:string)=>f.call(`/harnesses/native-alpha/native-sessions?${new URLSearchParams({controlId:"native-alpha",workspace:f.workspace,...(cursor===undefined?{}:{cursor})})}`);
  const first=await list();
  assert.equal(first.status,200);assert.deepEqual(first.value,{sessions:[{id:"native-a",title:"Earlier work",updatedAt:Date.parse("2026-10-01T10:00:00Z")}],nextCursor:"p2"});
  assert.deepEqual((await list("p2")).value.sessions,[{id:"native-b",title:null,updatedAt:Date.parse("2026-10-01T09:00:00Z")}]);
  const imported=await f.call("/sessions/import",{workspace:f.workspace,selection:{harnessId:"native-alpha"},nativeId:"native-a",commandId:"import"}),id=String(imported.value.id);
  assert.equal(imported.status,201);
  assert.deepEqual(imported.value.origin,{kind:"import",harnessId:"native-alpha",title:"Earlier work",omitted:0,complete:true,historyRead:true,history:[
    {role:"user",text:"first question",status:"completed"},{role:"assistant",text:"first answer",status:"completed",harnessId:"native-alpha"},
    {role:"user",text:"second question",status:"completed"},{role:"assistant",text:"second answer",status:"completed",harnessId:"native-alpha"}]});
  assert.deepEqual(imported.value.nativeStates,[{harnessId:"native-alpha",controlId:"native-alpha",status:"ready"}]);
  assert.ok(!JSON.stringify(imported.value).includes("native-a\""),"the native reference stays private");
  assert.deepEqual((await list()).value.sessions,[{id:"native-a",title:"Earlier work",updatedAt:Date.parse("2026-10-01T10:00:00Z"),conversationId:id}]);
  const again=await f.call("/sessions/import",{workspace:f.workspace,selection:{harnessId:"native-alpha"},nativeId:"native-a",commandId:"import-again"});
  assert.equal(again.status,409);assert.equal((again.value as {code:string}).code,"NATIVE_SESSION_CONFLICT");
  const elsewhere=await f.call("/sessions/import",{workspace:f.workspace,selection:{harnessId:"native-alpha"},nativeId:"native-x",commandId:"import-elsewhere"});
  assert.equal(elsewhere.status,404);assert.equal((elsewhere.value as {code:string}).code,"NATIVE_SESSION_NOT_FOUND");
  const sessions=(await f.call("/sessions")).value as unknown as {id:string;title:string}[];
  assert.equal(sessions.find(row=>row.id===id)?.title,"接续 · Earlier work");
  assert.equal((await f.call(`/sessions/${id}/messages`,{text:"what did I ask first?",commandId:"send"})).status,202);
  await f.until(`/sessions/${id}`,row=>Array.isArray(row.runs)&&row.runs.length===1&&(row.runs[0] as {status:string}).status==="completed");
  const wire=await f.wire(),load=wire.filter(row=>row.method==="session/load").at(-1)!,prompt=wire.filter(row=>row.method==="session/prompt").at(-1)!;
  assert.equal((load.params as {sessionId:string}).sessionId,"native-a","the conversation continues the native session itself");
  assert.deepEqual((prompt.params as {prompt:unknown}).prompt,[{type:"text",text:"what did I ask first?"}],"the native session gets the input without a public context");
});
