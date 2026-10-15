import type {Agenda,Caller,Context,HostSeat,Inputs,Member,SeatRequest,Ticket} from './model.ts';
import {availability,caseOpen,effectOpen,memberEnded,memberOf,unitEnded} from './identity.ts';
import {caseBrief,designBrief,gateBrief,reportBrief,spawnBrief,workBrief} from './briefs.ts';

export function candidateFor(request:SeatRequest,input:Inputs):HostSeat|undefined {
  if(request.runId!==input.host.runId)return undefined;
  if(request.binding.kind==='bound'){
    const binding=request.binding;
    return input.host.seats.find(seat=>seat.agentId===binding.agentId&&seat.parentId===binding.parentId&&seat.status!=='aborted');
  }
  return input.host.seats.map((seat,index)=>({seat,index})).filter(({seat})=>seat.parentId===input.host.main.agentId&&seat.status!=='aborted'&&(seat.requestedName===request.name||new RegExp(`^${request.name}-(?:[2-9]|[1-9][0-9]+)$`).test(seat.requestedName))).sort((a,b)=>a.seat.createdAt-b.seat.createdAt||a.index-b.index)[0]?.seat;
}
export function callerOwns(request:SeatRequest,input:Inputs,caller:Caller):boolean {
  const candidate=candidateFor(request,input);
  return caller.kind==='sub'&&caller.depth===1&&caller.runId===input.host.runId&&caller.parentId===input.host.main.agentId&&candidate?.agentId===caller.agentId&&candidate.sessionId===caller.sessionId;
}
export function mainCaller(input:Inputs,caller:Caller):boolean {
  return caller.kind==='main'&&caller.depth===0&&caller.agentId===input.host.main.agentId&&caller.sessionId===input.host.main.sessionId&&caller.runId===input.host.runId;
}
function holder(state:Agenda,requestId:string|null,input:Inputs):Ticket['holder'] {
  if(requestId===null)return {kind:'main'};
  const request=state.requests.find(request=>request.id===requestId);
  return {kind:'seat',requestId,agentId:request?candidateFor(request,input)?.agentId??null:null};
}
function ticketWork(state:Agenda,input:Inputs,member:Member):Ticket|null {
  if(!member.work)return null;
  const work=member.work;const disposition=availability(state,work,input).kind==='held'?'mayWait':'mustRun';
  return {agendaId:state.id,id:`work:${work.id}`,revision:work.contentVersion,holder:holder(state,member.designOnly?null:member.ownerRequestId,input),context:{kind:'member',member:member.ref},brief:workBrief(state,input,work,member),allowedReplies:['submit','claim'],runDisposition:disposition,attentionRequired:disposition==='mustRun'};
}
export function tickets(state:Agenda,input:Inputs):readonly Ticket[] {
  if(state.lifecycle==='completed')return [];
  const result:Ticket[]=[];
  for(const unit of state.units){
    for(const member of unit.members){const work=ticketWork(state,input,member);if(work)result.push(work);}
    for(const gate of [unit.postMerge,...unit.members.flatMap(member=>[member.review,member.accept])]){
      if(gate?.status.kind!=='requested'||caseOpen(state,gate.context)||effectOpen(state,gate.context))continue;
      if(gate.context.kind==='member'&&memberOf(state,gate.context.member)?.work)continue;
      if(gate.kind==='postMerge'&&input.facts.kind==='available'&&!unit.members.every(member=>memberEnded(state,member,input)))continue;
      result.push({agendaId:state.id,id:`gate:${gate.id}`,revision:1,holder:holder(state,gate.requestId,input),context:gate.context,brief:gateBrief(state,input,gate),allowedReplies:['verdict','claim'],runDisposition:input.facts.kind==='available'?'mustRun':'mayWait',attentionRequired:input.facts.kind==='available'});
    }
  }
  if(state.closure?.status.kind==='requested'&&!caseOpen(state,{kind:'agenda'})&&!effectOpen(state,{kind:'agenda'})&&(input.facts.kind==='unavailable'||state.units.every(unit=>unitEnded(state,unit,input)))){
    const gate=state.closure;
    result.push({agendaId:state.id,id:`gate:${gate.id}`,revision:1,holder:holder(state,gate.requestId,input),context:gate.context,brief:gateBrief(state,input,gate),allowedReplies:['verdict','claim'],runDisposition:input.facts.kind==='available'?'mustRun':'mayWait',attentionRequired:input.facts.kind==='available'});
  }
  for(const work of state.designWorks)if(work.result===null){
    const disposition=availability(state,work,input).kind==='held'?'mayWait':'mustRun';
    result.push({agendaId:state.id,id:`work:${work.id}`,revision:work.contentVersion,holder:{kind:'main'},context:state.cases.find(item=>item.id===work.parentCaseId)?.context??{kind:'agenda'},brief:designBrief(state,input,work),allowedReplies:['designCommit','claim'],runDisposition:disposition,attentionRequired:disposition==='mustRun'});
  }
  for(const item of state.cases)if(item.state.kind==='open'||item.state.kind==='awaitingExternal')result.push({agendaId:state.id,id:`case:${item.id}`,revision:item.contentVersion,holder:{kind:'main'},context:item.context,brief:caseBrief(state,input,item),allowedReplies:['decision'],runDisposition:item.state.kind==='awaitingExternal'||input.facts.kind==='unavailable'?'mayWait':'mustRun',attentionRequired:item.state.kind==='open'});
  const activeRequestIds=new Set(result.flatMap(ticket=>ticket.holder.kind==='seat'?[ticket.holder.requestId]:[]));
  for(const request of state.requests){
    const candidate=candidateFor(request,input);
    if(request.runId!==input.host.runId)continue;
    if((activeRequestIds.has(request.id)&&!candidate)||(candidate&&request.binding.kind==='unbound'))result.push({agendaId:state.id,id:`spawn:${request.id}`,revision:1,holder:{kind:'main'},context:request.context,brief:spawnBrief(state,input,request,candidate?.agentId??null),allowedReplies:['spawned'],runDisposition:'mustRun',attentionRequired:true});
  }
  if(state.report?.state.kind==='requested'){
    const report=state.report;
    result.push({agendaId:state.id,id:`work:${report.id}`,revision:report.contentVersion,holder:{kind:'main'},context:{kind:'agenda'},brief:reportBrief(state,input,report),allowedReplies:['report'],runDisposition:'mustRun',attentionRequired:true});
  }
  return result;
}
export function callerTickets(state:Agenda,input:Inputs,caller:Caller):readonly Ticket[] {
  return tickets(state,input).filter(ticket=>{
    const holder=ticket.holder;
    return holder.kind==='main'?mainCaller(input,caller):state.requests.some(request=>request.id===holder.requestId&&callerOwns(request,input,caller));
  });
}
