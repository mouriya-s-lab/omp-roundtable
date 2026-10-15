import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import type { Agenda, AgendaId, Caller, CheckAttempt, CreatedIssueObservation, Facts, HostObservation, IssueRef, IssueSnapshot, Millis, Policy, PortError, PrRef, PrSnapshot, Repo, Result, Sha, SourceScope, Target } from '../domain/model.ts';

export type PrWrite = {headRepo:Repo;branch:string;head:Sha;target:Target;title:string;body:string};
export type IssueWrite = {repo:Repo;title:string;body:string};
export interface GitHubPort {
  facts(scope:SourceScope,cause:string):Promise<Result<Facts,PortError>>;
  contains(repo:Repo,ancestor:Sha,descendant:Sha):Promise<Result<'contains'|'notContained'|'missing',PortError>>;
  branchHead(repo:Repo,branch:string):Promise<Result<{kind:'missing'}|{kind:'present';head:Sha},PortError>>;
  issue(ref:IssueRef):Promise<Result<IssueSnapshot,PortError>>;
  pr(ref:PrRef):Promise<Result<PrSnapshot,PortError>>;
  openPrsByHead(headRepo:Repo,branch:string,target:Target):Promise<Result<readonly PrSnapshot[],PortError>>;
  issuesCreatedSince(repo:Repo,since:Millis):Promise<Result<readonly CreatedIssueObservation[],PortError>>;
  checkAttempt(repo:Repo,runId:number):Promise<Result<CheckAttempt,PortError>>;
  createIssue(input:IssueWrite):Promise<Result<IssueRef,PortError>>;
  addSubIssue(parent:IssueRef,child:IssueRef):Promise<Result<null,PortError>>;
  editIssueBody(issue:IssueRef,expectedHash:string,body:string):Promise<Result<null,PortError>>;
  setIssueOpen(issue:IssueRef,open:boolean):Promise<Result<null,PortError>>;
  createPr(input:PrWrite):Promise<Result<PrRef,PortError>>;
  editPr(pr:PrRef,input:PrWrite):Promise<Result<null,PortError>>;
  mergePr(pr:PrRef,head:Sha):Promise<Result<null,PortError>>;
  rerunCheck(repo:Repo,workflowRunId:number):Promise<Result<null,PortError>>;
}
export type StateError = {kind:'notFound'|'unsupportedFormat'|'corruptState'|'versionConflict'|'unavailable';message:string};
export interface AgendaFiles {
  load(id:AgendaId):Promise<Result<Agenda,StateError>>;
  list():Promise<Result<readonly Agenda[],StateError>>;
  /** Exact-target retries repair durability; they never increment the supplied version. */
  save(expectedVersion:number|null,state:Agenda):Promise<Result<null,StateError>>;
}
export type FileMetrics = {replaces:number;unchangedReplaces:number};
export type WakeInput = {requestId:string;runId:string;agentId:string;parentId:string;messageId:string;body:string;startedAt:Millis};
export type DeliveryReceipt = {agentId:string;messageId:string;outcome:'injected'|'woken'};
export interface HostPort {
  bind(ctx:ExtensionContext,runId:string):Result<Caller,PortError>;
  release(ctx:ExtensionContext):void;
  observe(runId:string,main:Caller):Result<HostObservation,PortError>;
  validate(cwd:string,agents:readonly string[]):Promise<Result<HostObservation['preflight'] extends Result<infer T,PortError>?T:never,PortError>>;
  wake(input:WakeInput):Promise<Result<DeliveryReceipt,PortError>>;
  noteTurnEnd(agentId:string,runId:string,messageId:string):void;
  dispose():void;
}
export type PolicyReader = ()=>Promise<Result<Policy,PortError>>;
