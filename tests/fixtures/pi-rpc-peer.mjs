import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';
const scenario=process.argv[2]??'basic', selected=process.argv.indexOf('--model'), current=selected<0?'one':process.argv[selected+1];
const restored=process.argv.indexOf('--session'), sessionFile=process.argv.includes('--no-session')?null:restored<0?process.env.FIXTURE_SESSION_FILE:process.argv[restored+1];
function emit(value){process.stdout.write(JSON.stringify(value)+'\n');}
function response(m,data){emit({type:'response',id:m.id,command:m.type,success:true,...(data===undefined?{}:{data})});}
function ended(reason='stop'){emit({type:'agent_end',messages:[{role:'assistant',stopReason:reason}]});}
function settled(){emit({type:'agent_settled'});}
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(process.env.FIXTURE_TRACE)appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify(m)+'\n');
 if(m.type==='get_commands'){response(m,{commands:[]});}
 else if(m.type==='get_state'){if(scenario==='bad-json'){process.stdout.write('invalid\n');return;}response(m,{sessionId:scenario==='restore-wrong'&&restored>=0?'pi-replacement':'pi-fixture',...(sessionFile?{sessionFile}:{}),model:{provider:'native',id:current,name:current},isStreaming:false});}
 else if(m.type==='get_available_models')response(m,{models:[{provider:'native',id:'one',name:'One'},{provider:'native',id:'two',name:'Two'}]});
 else if(m.type==='prompt'){
  if(scenario==='rejected'){emit({type:'response',id:m.id,command:m.type,success:false,error:'Authentication required private-key'});return;}
  if(scenario!=='pre-ack')response(m);
  if(scenario.startsWith('ui-')){const method=scenario.slice(3);emit({type:'extension_ui_request',id:'native-ui',method,title:'Native UI request',...(method==='select'?{options:['One','Two']}:method==='editor'?{prefilled:'native draft'}:{placeholder:'native input'})});return;}
  emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Pi native answer'}});
  if(scenario==='hold')return;
  ended();if(scenario==='end-only')return;
  if(scenario==='retry'){setTimeout(()=>{emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:' retry result'}});ended();settled();},30);return;}
  settled();if(scenario==='pre-ack')setTimeout(()=>response(m),20);
 }else if(m.type==='extension_ui_response'){emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Native form accepted'}});ended();settled();}
 else if(m.type==='abort'){response(m);ended('aborted');settled();}
 else{emit({type:'response',id:m.id,command:m.type,success:false,error:'Unexpected command'});}
});
