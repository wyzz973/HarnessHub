import{createInterface}from'node:readline';import{appendFileSync,readFileSync,writeFileSync}from'node:fs';
// Mirrors Pi 0.85.1 RPC (src/modes/rpc/rpc-mode.ts): ack before agent_start, isStreaming during runs, editor `prefill` / `{value}`, dialog `timeout`.
const restored=process.argv.indexOf('--session'), sessionFile=process.argv.includes('--no-session')?null:restored<0?process.env.FIXTURE_SESSION_FILE:process.argv[restored+1];
// Like Pi, a restored session without a model flag runs the model and thinking level its file last recorded.
function saved(type,key){if(restored<0)return undefined;try{return readFileSync(sessionFile,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.type===type).at(-1)?.[key];}catch{return undefined;}}
const scenario=process.argv[2]??'basic', selected=process.argv.indexOf('--model'), current=selected<0?saved('model_change','modelId')??'one':process.argv[selected+1];
let streaming=false,cloned=false,thinking=saved('thinking_level_change','thinkingLevel')??'off';
function emit(value){process.stdout.write(JSON.stringify(value)+'\n');}
function response(m,data){emit({type:'response',id:m.id,command:m.type,success:true,...(data===undefined?{}:{data})});}
function started(){streaming=true;emit({type:'agent_start'});}
function ended(reason='stop'){emit({type:'agent_end',messages:[{role:'assistant',stopReason:reason}]});}
function settled(){streaming=false;emit({type:'agent_settled'});}
const models=[{provider:'native',id:'one',name:'One',reasoning:false,contextWindow:64000,input:['text']},{provider:'native',id:'two',name:'Two',reasoning:true,thinkingLevelMap:{max:'max',minimal:null},input:['text','image']}];
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(process.env.FIXTURE_TRACE)appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify(m)+'\n');
 if(m.type==='get_commands'){response(m,{commands:scenario==='native-compact'?[{name:'compact',description:'extension compact'}]:scenario==='extensions'?[{name:'deploy',description:'Deploy the app',source:'extension',sourceInfo:{path:'/home/u/.pi/agent/extensions/deploy/index.ts',source:'local',scope:'user',origin:'top-level'}},{name:'status',description:'Show status',source:'extension',sourceInfo:{path:'/home/u/.pi/agent/extensions/deploy/index.ts',source:'local',scope:'user',origin:'top-level'}},{name:'review',description:'Review template',source:'prompt',sourceInfo:{path:'/p/review.md',source:'local',scope:'project',origin:'top-level'}},{name:'skill:pdf',description:'Read PDFs',source:'skill',sourceInfo:{path:'/s/pdf/SKILL.md',source:'local',scope:'user',origin:'package'}}]:[]});}
 else if(m.type==='clone'){if(scenario==='clone-cancelled'){response(m,{cancelled:true});return;}cloned=true;response(m,{cancelled:false});}
 else if(m.type==='export_html'){if(scenario==='nothing-to-export'){emit({type:'response',id:m.id,command:m.type,success:false,error:'Nothing to export yet'});return;}writeFileSync(m.outputPath,'<html>pi</html>');response(m,{path:m.outputPath});}
 else if(m.type==='compact'){emit({type:'compaction_start',reason:'manual'});emit({type:'compaction_end',reason:'manual',aborted:false,willRetry:false});response(m,{summary:'kept',firstKeptEntryId:'e1',tokensBefore:1000,estimatedTokensAfter:200});}
 else if(m.type==='get_state'){if(scenario==='bad-json'){process.stdout.write('invalid\n');return;}response(m,{sessionId:cloned?'pi-clone':scenario==='restore-wrong'&&restored>=0?'pi-replacement':'pi-fixture',...(sessionFile?{sessionFile:cloned?sessionFile+'.clone':sessionFile}:{}),model:models.find(row=>row.id===current)??{provider:'native',id:current,name:current},thinkingLevel:thinking,isStreaming:streaming});}
 else if(m.type==='set_thinking_level'){thinking=m.level;response(m);}
 else if(m.type==='get_available_models')response(m,{models});
 else if(m.type==='get_available_thinking_levels')response(m,{levels:current==='two'?['off','low','high','max']:['off']});
 else if(m.type==='prompt'){
  if(scenario==='rejected'||scenario==='rejected-long'){emit({type:'response',id:m.id,command:m.type,success:false,error:'Authentication required private-key'+(scenario==='rejected-long'?' '+'z'.repeat(100000):'')});return;}
  if(scenario!=='pre-ack')response(m);
  if(scenario==='handled')return;
  if(scenario==='late-run'){setTimeout(()=>{started();emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'late native run'}});ended();settled();},50);return;}
  started();
  if(scenario==='native-activity'){
   emit({type:'tool_execution_start',toolCallId:'bash-1',toolName:'bash',args:{command:'ls\n-la'}});
   emit({type:'tool_execution_update',toolCallId:'bash-1',toolName:'bash',args:{command:'ls\n-la'},partialResult:{content:[{type:'text',text:'partial'}]}});
   emit({type:'tool_execution_end',toolCallId:'bash-1',toolName:'bash',result:{content:[{type:'text',text:'a.txt'}],details:{}},isError:false});
   emit({type:'tool_execution_start',toolCallId:'edit-1',toolName:'edit',args:{path:'/w/a.txt',edits:[{oldText:'x',newText:'y'}]}});
   emit({type:'tool_execution_end',toolCallId:'edit-1',toolName:'edit',result:{content:[{type:'text',text:'Edited'}],details:{patch:'--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n'}},isError:false});
   emit({type:'message_end',message:{role:'assistant',usage:{input:100,output:20,cacheRead:5,cacheWrite:0,totalTokens:125,cost:{total:0.001}}}});
   emit({type:'message_end',message:{role:'assistant',usage:{input:130,output:30,cacheRead:5,cacheWrite:0,reasoning:4,totalTokens:165,cost:{total:0.002}}}});
   emit({type:'compaction_start',reason:'threshold'});emit({type:'compaction_end',reason:'threshold',aborted:false,willRetry:false});
   emit({type:'extension_ui_request',id:'notify-1',method:'notify',message:'Extension says hi',notifyType:'warning'});
   emit({type:'extension_error',extensionPath:'/x',event:'command',error:'boom'});
   emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'done'}});ended();settled();return;
  }
  if(scenario==='ui-timeout'){emit({type:'extension_ui_request',id:'native-ui',method:'select',title:'Timed request',options:['One','Two'],timeout:40});setTimeout(()=>{emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'default used'}});ended();settled();},120);return;}
  if(scenario.startsWith('ui-')){const method=scenario.slice(3);emit({type:'extension_ui_request',id:'native-ui',method,title:'Native UI request',...(method==='select'?{options:['One','Two']}:method==='editor'?{prefill:process.env.FIXTURE_PREFILL_BYTES?'p'.repeat(Number(process.env.FIXTURE_PREFILL_BYTES)):'native draft'}:{placeholder:'native input'})});return;}
  emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Pi native answer'}});
  if(scenario==='hold')return;
  if(scenario==='terminate'){ended('toolUse');settled();return;}
  ended();if(scenario==='end-only')return;
  if(scenario==='retry'){setTimeout(()=>{emit({type:'agent_start'});emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:' retry result'}});ended();settled();},30);return;}
  settled();if(scenario==='pre-ack')setTimeout(()=>response(m),20);
 }else if(m.type==='extension_ui_response'){emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Native form accepted'}});ended();settled();}
 else if(m.type==='abort'){response(m);ended('aborted');settled();}
 else{emit({type:'response',id:m.id,command:m.type,success:false,error:'Unexpected command'});}
});
