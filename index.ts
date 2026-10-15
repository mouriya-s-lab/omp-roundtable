import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {getAgentDir,logger,z,type ExtensionAPI,type ExtensionContext} from '@oh-my-pi/pi-coding-agent';
import {register} from '@oh-my-pi/pi-coding-agent/config/registry';
import {AgentRegistry,MAIN_AGENT_ID} from '@oh-my-pi/pi-coding-agent/registry/agent-registry';
import {buildPublicGrammar} from './src/domain/public-grammar.ts';
import {parseToolParameters} from './src/domain/parse.ts';
import type {Caller,ParseError,Policy,PortError,Result} from './src/domain/model.ts';
import {createAgendaFiles} from './src/ports/state.ts';
import {createGitHubPort} from './src/ports/github.ts';
import {createHostPort} from './src/ports/host.ts';
import {RoundtableController,type ControllerOutput,type RuntimeError} from './src/runtime/controller.ts';

const SLOT=Symbol.for('omp-roundtable.runtime.v3');
type SessionBinding={pi:ExtensionAPI;ctx:ExtensionContext;caller:Caller;activation:Promise<void>};
type ToolResponse=Result<ControllerOutput,RuntimeError|{kind:'parse';error:ParseError}>;

function requireText(value:unknown):void {if(typeof value!=='string'||value.trim().length===0)throw new Error('Roundtable setting must be a nonempty string');}
function requireInterval(value:unknown):void {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>2_147_483)throw new Error('Roundtable recompute interval must be a positive safe whole number of seconds within the native timer range');}
function errorText(error:RuntimeError):string {return JSON.stringify(error);}

/** Native reevaluates module graphs per seat; this object lives in the process slot. */
class ProcessRuntime {
  private readonly interval=register({id:'roundtable.recomputeIntervalSeconds',type:'number',default:120,env:'OMP_ROUNDTABLE_RECOMPUTE_SECONDS',validate:requireInterval});
  private readonly directory=register({id:'roundtable.dataDir',type:'string',default:join(getAgentDir(),'omp-roundtable'),env:'OMP_ROUNDTABLE_DIR',validate:requireText});
  private readonly owner=register({id:'roundtable.ownerAgent',type:'string',default:'task:high',env:'OMP_ROUNDTABLE_OWNER_AGENT',validate:requireText});
  private readonly gate=register({id:'roundtable.gateAgent',type:'string',default:'task:mid',env:'OMP_ROUNDTABLE_GATE_AGENT',validate:requireText});
  private readonly bindings=new Map<ExtensionContext['sessionManager'],SessionBinding>();
  private readonly reminded=new Set<string>();
  private readonly host=createHostPort(id=>this.controller?.request(id));
  private readonly unsubscribe=AgentRegistry.global().onChange(()=>this.controller?.registryChanged());
  private controller:RoundtableController|null=null;
  private mainPrompt:readonly string[]|null=null;
  private notification:Promise<void>=Promise.resolve();
  private lastError:string|null=null;
  private closed=false;

  bind(pi:ExtensionAPI,ctx:ExtensionContext):Result<SessionBinding,PortError> {
    if(this.closed)return {ok:false,error:{kind:'precondition',message:'Roundtable runtime has shut down; start a new OMP process'}};
    if(!this.controller){
      if(ctx.agent.id!==MAIN_AGENT_ID||ctx.agent.kind!=='main')return {ok:false,error:{kind:'precondition',message:'Main must initialize Roundtable before child sessions'}};
      const session=AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
      if(!session||session.sessionManager!==ctx.sessionManager)return {ok:false,error:{kind:'precondition',message:'Main settings do not belong to the current native session'}};
      this.mainPrompt=ctx.getSystemPrompt();
      this.controller=new RoundtableController({
        files:createAgendaFiles(resolve(ctx.cwd,this.directory.get(session.settings))),github:createGitHubPort(),host:this.host,
        policy:()=>this.readPolicy(),intervalSeconds:this.interval.get(session.settings),
        onChange:()=>this.changed(),onError:error=>this.report(error),
      });
    }
    const caller=this.host.bind(ctx,this.controller.runId);if(!caller.ok)return caller;
    if(caller.value.kind==='main')this.controller.setMain(caller.value);
    const prior=this.bindings.get(ctx.sessionManager);
    const binding:SessionBinding={pi,ctx,caller:caller.value,activation:prior?.activation??Promise.resolve()};
    this.bindings.set(ctx.sessionManager,binding);return {ok:true,value:binding};
  }
  capture(ctx:ExtensionContext,prompt:readonly string[]):void {if(ctx.agent.id===MAIN_AGENT_ID&&ctx.agent.kind==='main')this.mainPrompt=[...prompt];}
  private async readPolicy():Promise<Result<Policy,PortError>> {
    const session=AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
    if(!session||!this.mainPrompt?.length)return {ok:false,error:{kind:'unavailable',message:'The actual Main system policy is not available'}};
    let text=this.mainPrompt.join('\n\n');
    try {
      const appendix=await readFile(join(getAgentDir(),'APPEND_SYSTEM.md'),'utf8');
      if(appendix.length&&!text.includes(appendix))text+=`\n\n${appendix}`;
    }catch(error){
      if(!(typeof error==='object'&&error!==null&&'code'in error&&error.code==='ENOENT'))return {ok:false,error:{kind:'unavailable',message:`Cannot read Main APPEND_SYSTEM.md: ${error instanceof Error?error.message:'filesystem failure'}`}};
    }
    return {ok:true,value:{text,ownerAgent:this.owner.get(session.settings),gateAgent:this.gate.get(session.settings)}};
  }
  private report(error:RuntimeError):void {
    const text=errorText(error);logger.error('Roundtable runtime error',{error:text});
    const main=[...this.bindings.values()].find(binding=>binding.caller.kind==='main');
    if(main&&text!==this.lastError){this.lastError=text;main.ctx.ui.notify(`Roundtable: ${text}`,'error');main.pi.sendMessage({customType:'roundtable-error',content:text,display:true},{triggerTurn:false});}
  }
  private failed(error:unknown):void {this.report({kind:'host',error:{kind:'unavailable',message:error instanceof Error?error.message:'Unexpected native extension failure'}});}
  async activate(binding:SessionBinding):Promise<void> {
    const refresh=async()=>{
      const tools=binding.pi.getActiveTools();const visible=this.controller?.visible(binding.caller)??false;
      const present=tools.includes('roundtable');if(present===visible)return;
      await binding.pi.setActiveTools(visible?[...tools,'roundtable']:tools.filter(name=>name!=='roundtable'));
    };
    binding.activation=binding.activation.then(refresh,refresh);await binding.activation;
  }
  private changed():void {
    this.notification=this.notification.then(async()=>{
      for(const binding of this.bindings.values())await this.activate(binding);
      const main=[...this.bindings.values()].find(binding=>binding.caller.kind==='main');
      if(!main||!this.controller)return;
      const result=await this.controller.context(main.caller);if(!result.ok){this.report(result.error);return;}
      if(!result.value)return;
      const newTickets=result.value.tickets.filter(ticket=>ticket.runDisposition==='mustRun'&&!this.reminded.has(`${this.controller!.runId}:${ticket.id}:${ticket.revision}`));
      if(!newTickets.length)return;
      for(const ticket of newTickets)this.reminded.add(`${this.controller.runId}:${ticket.id}:${ticket.revision}`);
      const content='Roundtable requested Main attention. Call roundtable tickets and act only on the current injected tickets; this queued reminder does not establish that an earlier ticket is still actionable. Relay text is not a protocol response.';
      main.pi.sendMessage({customType:'roundtable-attention',content,display:true},{triggerTurn:true,deliverAs:'nextTurn'});
    }).catch(error=>this.failed(error));
  }
  async command(binding:SessionBinding,args:string):Promise<void> {
    if(binding.caller.kind!=='main'||binding.caller.depth!==0){binding.ctx.ui.notify('Only Main may change Roundtable mode','error');return;}
    const command=args.trim();
    if(command!==''&&command!=='off'){binding.ctx.ui.notify('Use /roundtable or /roundtable off; convene/resume are structured tool operations','error');return;}
    if(!this.controller)throw new Error('Main controller is not initialized');
    const result=await this.controller.mode(binding.caller,command!=='off');
    await this.activate(binding);
    binding.pi.sendMessage({customType:'roundtable-mode',content:JSON.stringify(result),display:true},{triggerTurn:false});
    if(!result.ok)binding.ctx.ui.notify(errorText(result.error),'error');
  }
  async execute(binding:SessionBinding,params:unknown):Promise<ToolResponse> {
    const parsed=parseToolParameters(params);
    if(!parsed.ok)return {ok:false,error:{kind:'parse',error:parsed.error}};
    if(!this.controller)return {ok:false,error:{kind:'domain',error:{kind:'roundtableInactive',message:'Main controller is not initialized',current:null}}};
    return this.controller.execute(binding.caller,parsed.value.input,binding.ctx.cwd);
  }
  visible(binding:SessionBinding):boolean {return this.controller?.visible(binding.caller)??false;}
  async context(binding:SessionBinding):Promise<string|null> {
    if(!this.controller)return null;
    const result=await this.controller.context(binding.caller);
    if(!result.ok)return `Roundtable operation is blocked by an actual runtime error: ${errorText(result.error)}`;
    const view=result.value;if(!view)return null;
    return `Roundtable ${view.agenda}, version ${view.version}, ${view.lifecycle}. Source error: ${JSON.stringify(view.sourceError)}.\n\n${view.tickets.map(ticket=>ticket.brief).join('\n\n')}\n\nCurrent applying/waiting effects and cases, external merge notices, and report:\n${JSON.stringify({cases:view.cases,effects:view.effects,externalMerges:view.externalMerges,report:view.report})}`;
  }
  async yieldBlock(binding:SessionBinding):Promise<string|null> {
    if(binding.caller.kind!=='sub'||!this.controller||!this.visible(binding))return null;
    const result=await this.controller.context(binding.caller);if(!result.ok)return `Roundtable cannot establish the current work: ${errorText(result.error)}`;
    const mustRun=result.value?.tickets.filter(ticket=>ticket.runDisposition==='mustRun')??[];
    return mustRun.length?`An ordinary yield is not a protocol completion. Submit the required reply or open your own claim before yielding.\n${mustRun.map(ticket=>ticket.brief).join('\n\n')}`:null;
  }
  async end(binding:SessionBinding):Promise<void> {
    this.controller?.noteTurnEnd(binding.caller);
    if(binding.caller.kind!=='main'||!this.controller)return;
    const result=await this.controller.context(binding.caller);
    if(result.ok&&result.value?.tickets.some(ticket=>ticket.attentionRequired))binding.ctx.ui.notify('Roundtable still has unanswered Main tickets; they remain open and visible through roundtable tickets','warning');
  }
  release(ctx:ExtensionContext):void {
    const binding=this.bindings.get(ctx.sessionManager);
    this.host.release(ctx);this.bindings.delete(ctx.sessionManager);
    if(binding?.caller.kind==='main'){
      this.closed=true;this.unsubscribe();this.controller?.shutdown();
    }
  }
}

// The cast only declares a process-owned symbol slot. No domain/source payload is
// cast or reconstructed across graphs, and constructor identity is never tested.
const processSlots=globalThis as typeof globalThis&{[SLOT]?:ProcessRuntime};

export default function roundtable(pi:ExtensionAPI):void {
  const runtime=processSlots[SLOT]??(processSlots[SLOT]=new ProcessRuntime());
  const grammar=buildPublicGrammar(z);
  const bind=(ctx:ExtensionContext)=>runtime.bind(pi,ctx);
  pi.registerTool({
    name:'roundtable',label:'Roundtable',description:'Operate the current Roundtable delivery protocol. Available only in Roundtable mode to Main and its exact current seats. Use tickets before replying; terminal receipts are durable, not relay acknowledgements.',
    parameters:grammar.toolParametersSchema,defaultInactive:true,
    async execute(_toolCallId,params,_signal,_onUpdate,ctx){
      const binding=bind(ctx);
      const response:ToolResponse=binding.ok?await runtime.execute(binding.value,params):{ok:false,error:{kind:'host',error:binding.error}};
      return {content:[{type:'text',text:JSON.stringify(response)}],details:response};
    },
  });
  pi.registerCommand('roundtable',{description:'Enter Roundtable delivery mode; off is allowed only after the agenda finishes',async handler(args,ctx){const binding=bind(ctx);if(!binding.ok){ctx.ui.notify(binding.error.message,'error');return;}await runtime.command(binding.value,args);}});
  pi.on('session_start',async(_event,ctx)=>{const binding=bind(ctx);if(binding.ok)await runtime.activate(binding.value);else ctx.ui.notify(binding.error.message,'error');});
  pi.on('before_agent_start',async(event,ctx)=>{runtime.capture(ctx,event.systemPrompt);const binding=bind(ctx);if(binding.ok)await runtime.activate(binding.value);});
  pi.on('context',async(event,ctx)=>{
    const binding=bind(ctx);if(!binding.ok)return;
    const content=await runtime.context(binding.value);if(content===null)return;
    return {messages:[...event.messages.filter(message=>!(message.role==='custom'&&message.customType==='roundtable-current')),{role:'custom',customType:'roundtable-current',content,display:false,attribution:'agent',timestamp:Date.now()}]};
  });
  pi.on('tool_call',async(event,ctx)=>{
    if(event.toolName!=='roundtable'&&event.toolName!=='yield')return;
    const binding=bind(ctx);
    if(event.toolName==='roundtable'&&(!binding.ok||!runtime.visible(binding.value)))return {block:true,reason:'Roundtable is not active for this exact native session/request/holder'};
    if(event.toolName==='yield'&&binding.ok){const reason=await runtime.yieldBlock(binding.value);if(reason)return {block:true,reason};}
  });
  pi.on('agent_end',async(_event,ctx)=>{const binding=bind(ctx);if(binding.ok)await runtime.end(binding.value);});
  pi.on('session_shutdown',(_event,ctx)=>{runtime.release(ctx);});
}
