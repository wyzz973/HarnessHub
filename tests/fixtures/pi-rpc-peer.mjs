import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';
// Mirrors Pi 0.85.1 RPC (src/modes/rpc/rpc-mode.ts): ack before agent_start, isStreaming during runs, editor `prefill` / `{value}`, dialog `timeout`.
const scenario=process.argv[2]??'basic', selected=process.argv.indexOf('--model'), current=selected<0?'one':process.argv[selected+1];
const restored=process.argv.indexOf('--session'), sessionFile=process.argv.includes('--no-session')?null:restored<0?process.env.FIXTURE_SESSION_FILE:process.argv[restored+1];
let streaming=false;
function emit(value){process.stdout.write(JSON.stringify(value)+'\n');}
function response(m,data){emit({type:'response',id:m.id,command:m.type,success:true,...(data===undefined?{}:{data})});}
function started(){streaming=true;emit({type:'agent_start'});}
function ended(reason='stop'){emit({type:'agent_end',messages:[{role:'assistant',stopReason:reason}]});}
function settled(){streaming=false;emit({type:'agent_settled'});}
const models=[{provider:'native',id:'one',name:'One',reasoning:false},{provider:'native',id:'two',name:'Two',reasoning:true,thinkingLevelMap:{max:'max',minimal:null}}];
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(process.env.FIXTURE_TRACE)appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify(m)+'\n');
 if(m.type==='get_commands'){response(m,{commands:[]});}
 else if(m.type==='get_state'){if(scenario==='bad-json'){process.stdout.write('invalid\n');return;}response(m,{sessionId:scenario==='restore-wrong'&&restored>=0?'pi-replacement':'pi-fixture',...(sessionFile?{sessionFile}:{}),model:models.find(row=>row.id===current)??{provider:'native',id:current,name:current},thinkingLevel:'off',isStreaming:streaming});}
 else if(m.type==='get_available_models')response(m,{models});
 else if(m.type==='get_available_thinking_levels')response(m,{levels:current==='two'?['off','low','high','max']:['off']});
 else if(m.type==='prompt'){
  if(scenario==='rejected'){emit({type:'response',id:m.id,command:m.type,success:false,error:'Authentication required private-key'});return;}
  if(scenario!=='pre-ack')response(m);
  if(scenario==='handled')return;
  if(scenario==='late-run'){setTimeout(()=>{started();emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'late native run'}});ended();settled();},50);return;}
  started();
  if(scenario==='ui-timeout'){emit({type:'extension_ui_request',id:'native-ui',method:'select',title:'Timed request',options:['One','Two'],timeout:40});setTimeout(()=>{emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'default used'}});ended();settled();},120);return;}
  if(scenario.startsWith('ui-')){const method=scenario.slice(3);emit({type:'extension_ui_request',id:'native-ui',method,title:'Native UI request',...(method==='select'?{options:['One','Two']}:method==='editor'?{prefill:'native draft'}:{placeholder:'native input'})});return;}
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
