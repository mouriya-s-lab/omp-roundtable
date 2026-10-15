import { z, type ZodLikeSchema } from '@oh-my-pi/omptype/zod';
import { buildPublicGrammar } from './public-grammar.ts';

export const {text,ordinal,revision,millisSchema,shaSchema,hashSchema,idSchema,agendaIdSchema,repoSchema,issueRefSchema,prRefSchema,shaRefSchema,targetSchema,entrySchema,conveneSchema,positionSchema,draftSpecSchema,existingInsertionSchema,insertionSchema,bodyEditSchema,designRouteSchema,amendmentSchema,sourceConditionSchema,createdResultSchema,caseDecisionSchema,claimSchema,submitSchema,protocolReplySchema,portInputSchema,toolParametersSchema}=buildPublicGrammar(z);
const object=<const S extends Readonly<Record<string,ZodLikeSchema<unknown>>>>(shape:S)=>z.object(shape).strict();

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export type NonEmpty<T> = readonly [T, ...T[]];
export type AgendaId = string;
export type WorkId = string;
export type JobId = string;
export type CaseId = string;
export type EffectId = string;
export type DraftId = string;
export type AmendmentId = string;
export type RequestId = string;
export type UnitId = string;
export type RunId = string;
export type Millis = number;
export type Sha = string;
export type Hash = string;
export type TicketId = `work:${string}` | `gate:${string}` | `case:${string}` | `spawn:${string}`;

export type Repo = z.infer<typeof repoSchema>;
export type IssueRef = z.infer<typeof issueRefSchema>;
export type PrRef = z.infer<typeof prRefSchema>;
export type MemberRef = IssueRef;
export type ShaRef = z.infer<typeof shaRefSchema>;
export type Target = z.infer<typeof targetSchema>;
export type Entry = z.infer<typeof entrySchema>;
export type ConveneInput = z.infer<typeof conveneSchema>;
export const lifecycleEventSchema = object({ id: text, at: millisSchema });
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;
export const issueSnapshotSchema = object({ ref: issueRefSchema, body: z.string(), bodyHash: hashSchema, updatedAt: millisSchema, state: z.enum(['open','closed']), lastClose: lifecycleEventSchema.nullable(), lastReopen: lifecycleEventSchema.nullable(), children: z.array(issueRefSchema) });
export type IssueSnapshot = z.infer<typeof issueSnapshotSchema>;
export const requiredCheckIdentitySchema = object({ name: text, source: z.union([object({kind:z.literal('any')}),object({kind:z.literal('app'),id:revision})]) });
export type RequiredCheckIdentity = z.infer<typeof requiredCheckIdentitySchema>;
export const checkFailureSchema = z.union([
  object({kind:z.literal('actions'), identity:requiredCheckIdentitySchema,checkRunId:revision,workflowRunId:revision,jobId:revision,runAttempt:revision,head:shaSchema}),
  object({kind:z.literal('status'),identity:requiredCheckIdentitySchema,context:text,sha:shaSchema}),
]);
export type CheckFailure = z.infer<typeof checkFailureSchema>;
export const pendingCheckSchema = object({identity:requiredCheckIdentitySchema,head:shaSchema});
export const checksSchema = z.union([
  object({kind:z.literal('passing'),required:z.array(requiredCheckIdentitySchema)}),
  object({kind:z.literal('failing'),required:z.array(checkFailureSchema).min(1)}),
  object({kind:z.literal('pending'),required:z.array(pendingCheckSchema).min(1)}),
  object({kind:z.literal('unknown'),reason:text}),
]);
export type ChecksSnapshot = z.infer<typeof checksSchema>;
export const mergeRequirementsSchema = object({required:z.array(requiredCheckIdentitySchema),strict:z.boolean(),upToDate:z.boolean(),constraints:z.array(text)});
export type MergeRequirements = z.infer<typeof mergeRequirementsSchema>;
export const prStateSchema = z.union([
  object({kind:z.literal('open')}),object({kind:z.literal('closed')}),
  object({kind:z.literal('merged'),sha:shaSchema,at:millisSchema}),
]);
export const prSnapshotSchema = object({ref:prRefSchema,headRepo:repoSchema,headBranch:text,head:shaSchema,target:targetSchema,title:text,body:z.string(),bodyHash:hashSchema,updatedAt:millisSchema,state:prStateSchema,closes:z.array(issueRefSchema),mergeable:z.enum(['yes','no','unknown']),checks:checksSchema});
export type PrSnapshot = z.infer<typeof prSnapshotSchema>;
export const baseSnapshotSchema = object({name:text,state:z.union([
  object({kind:z.literal('missing')}),object({kind:z.literal('present'),head:shaSchema,isDefault:z.boolean(),rules:mergeRequirementsSchema}),
])});
export type BaseSnapshot = z.infer<typeof baseSnapshotSchema>;
export const repoSnapshotSchema = object({repo:repoSchema,defaultBranch:text,defaultHead:shaSchema,bases:z.array(baseSnapshotSchema)});
export type RepoSnapshot = z.infer<typeof repoSnapshotSchema>;
export const branchSnapshotSchema = object({repo:repoSchema,name:text,state:z.union([object({kind:z.literal('missing')}),object({kind:z.literal('present'),head:shaSchema})])});
export type BranchSnapshot = z.infer<typeof branchSnapshotSchema>;
export const commitObservationSchema = object({repo:repoSchema,ancestor:shaSchema,descendant:shaSchema,result:z.enum(['contains','notContained','missing'])});
export type CommitObservation = z.infer<typeof commitObservationSchema>;
export const maintenanceBasisSchema = object({headRepo:repoSchema,headBranch:text,viewerPermission:z.enum(['ADMIN','MAINTAIN','WRITE','TRIAGE','READ','NONE']),author:text,maintainerCanModify:z.boolean(),authorization:z.union([
  object({kind:z.literal('actorIsAuthor'),actor:text}),object({kind:z.literal('systemCreated'),effectId:idSchema}),object({kind:z.literal('authorAuthorized'),evidence:text}),object({kind:z.literal('none')}),
])});
export type MaintenanceBasis = z.infer<typeof maintenanceBasisSchema>;
export const maintenanceObservationSchema = object({pr:prRefSchema,result:z.union([
  object({kind:z.literal('maintainable'),basis:maintenanceBasisSchema}),object({kind:z.literal('foreign'),basis:maintenanceBasisSchema}),object({kind:z.literal('unknown'),reason:text}),
])});
export type MaintenanceObservation = z.infer<typeof maintenanceObservationSchema>;
export const closingLinkSchema = object({issue:issueRefSchema,pr:prRefSchema});
export const checkAttemptSchema = object({repo:repoSchema,workflowRunId:revision,attempt:revision,head:shaSchema});
export type CheckAttempt = z.infer<typeof checkAttemptSchema>;
export const createdIssueObservationSchema = object({issue:issueRefSchema,title:text,body:z.string(),actor:text,createdAt:millisSchema});
export type CreatedIssueObservation = z.infer<typeof createdIssueObservationSchema>;
export const factsSchema = object({viewer:text,issues:z.array(issueSnapshotSchema),prs:z.array(prSnapshotSchema),links:z.array(closingLinkSchema),repos:z.array(repoSnapshotSchema),branches:z.array(branchSnapshotSchema),maintenance:z.array(maintenanceObservationSchema),commits:z.array(commitObservationSchema),checkAttempts:z.array(checkAttemptSchema),createdIssues:z.array(createdIssueObservationSchema)});
export type Facts = z.infer<typeof factsSchema>;
export const maintenanceIntentSchema = z.union([
  object({kind:z.literal('systemCreated'),pr:prRefSchema,effectId:idSchema}),
  object({kind:z.literal('authorAuthorized'),pr:prRefSchema,author:text,commentId:revision,bodyHash:hashSchema}),
]);
export type MaintenanceIntent = z.infer<typeof maintenanceIntentSchema>;
export const repoReadScopeSchema=object({repo:repoSchema,bases:z.array(text)});
export type RepoReadScope=z.infer<typeof repoReadScopeSchema>;
export const sourceScopeSchema = object({issues:z.array(issueRefSchema),prs:z.array(prRefSchema),repos:z.array(repoReadScopeSchema),branches:z.array(object({repo:repoSchema,name:text})),commits:z.array(object({repo:repoSchema,ancestor:shaSchema,descendant:shaSchema})),checkRuns:z.array(object({repo:repoSchema,runId:revision})),creations:z.array(object({repo:repoSchema,since:millisSchema,title:text,body:z.string(),actor:text})),maintenanceIntents:z.array(maintenanceIntentSchema).optional()});
export type SourceScope = z.infer<typeof sourceScopeSchema>;
export const portErrorSchema = z.union([
  object({kind:z.literal('permission'),message:text}),object({kind:z.literal('rateLimited'),message:text,resetAt:millisSchema}),
  object({kind:z.literal('unavailable'),message:text}),object({kind:z.literal('precondition'),message:text}),
  object({kind:z.literal('invalidResponse'),message:text}),object({kind:z.literal('uncertainOutcome'),message:text}),
]);
export type PortError = z.infer<typeof portErrorSchema>;
export type FactRead = {kind:'available';generation:number;scope:SourceScope;observedAt:Millis;facts:Facts}|{kind:'unavailable';error:PortError};

export const callerSchema = object({agentId:text,sessionId:text,parentId:text.nullable(),runId:idSchema,kind:z.enum(['main','sub']),depth:ordinal});
export type Caller = z.infer<typeof callerSchema>;
export const hostSeatSchema = object({agentId:text,requestedName:text,parentId:text.nullable(),sessionId:text.nullable(),createdAt:millisSchema,status:z.enum(['running','idle','parked','aborted']),plan:z.enum(['enabled','disabled','unavailable']),streaming:z.boolean()});
export type HostSeat = z.infer<typeof hostSeatSchema>;
export type HostObservation = {runId:RunId;main:Caller;seats:readonly HostSeat[];turnEnds:readonly {agentId:string;runId:RunId;messageId:string}[];preflight:Result<{asyncEnabled:true;isolationEnabled:true;asyncManager:true;gitCwd:string;agents:readonly {name:string;blocking:false}[]},PortError>};
export type Policy = {text:string;ownerAgent:string;gateAgent:string};
export type Inputs = {facts:FactRead;host:HostObservation;policy:Policy};
export const contextSchema = z.union([
  object({kind:z.literal('member'),member:issueRefSchema}),object({kind:z.literal('unit'),unitId:idSchema}),object({kind:z.literal('agenda')}),
]);
export type Context = z.infer<typeof contextSchema>;
export const gateKindSchema = z.enum(['review','accept','postMerge','closure']);
export type GateKind = z.infer<typeof gateKindSchema>;
export type Position = z.infer<typeof positionSchema>;
export type DraftSpec = z.infer<typeof draftSpecSchema>;
export type Insertion = z.infer<typeof insertionSchema>;
export type BodyEdit = z.infer<typeof bodyEditSchema>;
export const carrierSchema = z.union([
  object({kind:z.literal('member'),member:issueRefSchema}),object({kind:z.literal('draft'),draftId:idSchema}),
]);
export type Carrier = z.infer<typeof carrierSchema>;
export type DesignRoute = z.infer<typeof designRouteSchema>;
export type Amendment = z.infer<typeof amendmentSchema>;
export type SourceCondition = z.infer<typeof sourceConditionSchema>;
export type CreatedResult = z.infer<typeof createdResultSchema>;
export type CaseDecision = z.infer<typeof caseDecisionSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type PrSubmit = z.infer<typeof submitSchema>;
export type ProtocolReply = z.infer<typeof protocolReplySchema>;
export type PortInput = z.infer<typeof portInputSchema>;
export type ToolParameters=z.infer<typeof toolParametersSchema>;
export const domainRefSchema = object({kind:z.enum(['work','gate','case','draft','amendment','effect','request','unit']),id:idSchema});
export type DomainRef = z.infer<typeof domainRefSchema>;
export const replyResultSchema = object({ticket:text,acceptedVersion:revision,outcome:z.enum(['accepted','claimOpened','reported']),created:z.array(domainRefSchema)});
export type ReplyResult = z.infer<typeof replyResultSchema>;
export const receiptSchema = object({ticket:text,revision,kind:z.literal('terminal'),digest:hashSchema,result:replyResultSchema});
export type Receipt = z.infer<typeof receiptSchema>;
export const claimReceiptSchema = object({ticket:text,revision,kind:z.literal('claim'),digest:hashSchema,result:replyResultSchema});
export type ClaimReceipt = z.infer<typeof claimReceiptSchema>;
export const holdRefSchema = z.union([
  object({kind:z.literal('case'),caseId:idSchema}),object({kind:z.literal('amendment'),id:idSchema}),object({kind:z.literal('dependency'),member:issueRefSchema}),object({kind:z.literal('effect'),effectId:idSchema}),
]);
export type HoldRef = z.infer<typeof holdRefSchema>;
export type WorkAvailability = {kind:'runnable'}|{kind:'held';holds:NonEmpty<HoldRef>};
export const workReasonSchema = z.union([
  object({kind:z.literal('initial')}),object({kind:z.literal('unsubmittedPush'),acceptedHead:shaSchema}),object({kind:z.literal('conflict'),base:shaSchema}),
  object({kind:z.literal('checks'),failures:z.array(checkFailureSchema).min(1)}),object({kind:z.literal('finding'),caseId:idSchema,basis:text}),
  object({kind:z.literal('design'),commit:shaRefSchema}),object({kind:z.literal('sourceChange'),caseId:idSchema,basis:text}),
]);
export type WorkReason = z.infer<typeof workReasonSchema>;
export const ownerWorkSchema = object({id:idSchema,member:issueRefSchema,reasons:z.array(workReasonSchema).min(1),required:z.array(shaRefSchema),target:targetSchema,baseline:shaSchema,contentVersion:revision,holds:z.array(holdRefSchema)});
export type OwnerWork = z.infer<typeof ownerWorkSchema>;
export const acceptedSubmissionSchema = object({workId:idSchema,payload:submitSchema});
export type AcceptedSubmission = z.infer<typeof acceptedSubmissionSchema>;
export const baselineSchema = z.union([
  object({kind:z.literal('none')}),object({kind:z.literal('adopted'),pr:prRefSchema,acceptedHead:shaSchema}),object({kind:z.literal('submitted'),submission:acceptedSubmissionSchema}),
]);
export const registeredBindingSchema=object({kind:z.literal('registered'),pr:prRefSchema,headRepo:repoSchema,branch:text,origin:z.enum(['adopted','published'])});
export const bindingSchema = z.union([
  object({kind:z.literal('none')}),object({kind:z.literal('publishing'),effectId:idSchema,previous:z.union([object({kind:z.literal('none')}), registeredBindingSchema])}),
  registeredBindingSchema,
]);
export const designRequirementSchema = object({caseId:idSchema,commit:shaRefSchema,carrier:carrierSchema,route:designRouteSchema});
export type DesignRequirement = z.infer<typeof designRequirementSchema>;
export const gateRulingSchema = z.union([
  object({kind:z.literal('findingRejected'),finding:text,basis:text,applicableContractRevision:revision}),
  object({kind:z.literal('questionAnswered'),question:text,classification:z.enum(['answer','outOfDomain']),basis:text,applicableContractRevision:revision}),
]);
export type GateRuling = z.infer<typeof gateRulingSchema>;
export const memberStampSchema = object({member:issueRefSchema,bodyHash:hashSchema,contractRevision:revision,required:z.array(shaRefSchema)});
export type MemberStamp = z.infer<typeof memberStampSchema>;
export const terminalSchema = z.union([
  object({kind:z.literal('pending')}),object({kind:z.literal('merged'),pr:prRefSchema,merge:shaRefSchema,at:millisSchema}),
  object({kind:z.literal('noCode'),bodyHash:hashSchema,reason:text,acceptedAt:millisSchema}),
]);
export type MemberTerminal = z.infer<typeof terminalSchema>;
export const terminalMemberStampSchema = object({member:memberStampSchema,terminal:terminalSchema});
export const verifyRepoSchema = object({repo:repoSchema,commit:shaSchema,merges:z.array(shaSchema)});
export type VerifyRepo = z.infer<typeof verifyRepoSchema>;
export const gateStampSchema = z.union([
  object({kind:z.literal('review'),pr:prRefSchema,head:shaSchema,target:targetSchema,prBodyHash:hashSchema,member:memberStampSchema,rulings:z.array(gateRulingSchema)}),
  object({kind:z.literal('accept'),pr:prRefSchema,head:shaSchema,target:targetSchema,member:memberStampSchema,rulings:z.array(gateRulingSchema)}),
  object({kind:z.literal('postMerge'),unitId:idSchema,members:z.array(terminalMemberStampSchema),repos:z.array(verifyRepoSchema),rulings:z.array(gateRulingSchema)}),
  object({kind:z.literal('closure'),parent:issueRefSchema,bodyHash:hashSchema,children:z.array(object({issue:issueRefSchema,terminal:terminalSchema})),units:z.array(object({id:idSchema,jobId:idSchema})),repos:z.array(verifyRepoSchema),outstanding:z.array(designRequirementSchema),rulings:z.array(gateRulingSchema)}),
]);
export type GateStamp = z.infer<typeof gateStampSchema>;
export const gateJobSchema = object({id:idSchema,kind:gateKindSchema,context:contextSchema,stamp:gateStampSchema,requestId:idSchema,status:z.union([
  object({kind:z.literal('requested')}),object({kind:z.literal('answered'),ok:z.boolean(),note:text}),object({kind:z.literal('cancelled'),reason:z.enum(['sourceChanged','claimOpened','workOpened','superseded'])}),
]),receipt:receiptSchema.nullable()});
export type GateJob = z.infer<typeof gateJobSchema>;
export const ownerTerminalSchema = z.union([
  object({kind:z.literal('submitted'),workId:idSchema,submission:acceptedSubmissionSchema}),object({kind:z.literal('noCode'),workId:idSchema,reason:text}),
  object({kind:z.literal('replacePr'),workId:idSchema,pr:prRefSchema,reason:text}),object({kind:z.literal('sourceRestored'),workId:idSchema,acceptedHead:shaSchema}),
  object({kind:z.literal('externallyMerged'),workId:idSchema,pr:prRefSchema,merge:shaRefSchema,mergedAt:millisSchema}),
]);
export type OwnerWorkTerminal = z.infer<typeof ownerTerminalSchema>;
export const memberSchema = object({ref:issueRefSchema,target:targetSchema,designOnly:z.boolean(),contract:object({revision,bodyHash:hashSchema,body:z.string(),requirements:z.array(designRequirementSchema)}),baseline:baselineSchema,binding:bindingSchema,work:ownerWorkSchema.nullable(),terminal:terminalSchema,ownerTerminal:ownerTerminalSchema.nullable(),ownerReceipt:receiptSchema.nullable(),ownerRequestId:idSchema.nullable(),review:gateJobSchema.nullable(),accept:gateJobSchema.nullable(),rulings:z.array(object({kind:gateKindSchema,ruling:gateRulingSchema})),fixedChecks:z.array(checkFailureSchema),reconciledEvent:text.nullable()});
export type Member = z.infer<typeof memberSchema>;
export const unitSchema = object({id:idSchema,members:z.array(memberSchema).min(1),postMerge:gateJobSchema.nullable(),rulings:z.array(gateRulingSchema)});
export type Unit = z.infer<typeof unitSchema>;
export const designWorkSchema = object({id:idSchema,parentCaseId:idSchema,affected:z.array(issueRefSchema).min(1),clauses:z.array(text),route:designRouteSchema,contentVersion:revision,holds:z.array(holdRefSchema),result:shaRefSchema.nullable(),receipt:receiptSchema.nullable()});
export type DesignWork = z.infer<typeof designWorkSchema>;
export const applyingRefSchema = z.union([
  object({kind:z.literal('design'),workId:idSchema}),object({kind:z.literal('amendment'),id:idSchema}),object({kind:z.literal('draft'),draftId:idSchema}),object({kind:z.literal('effect'),effectId:idSchema}),
]);
export type ApplyingRef = z.infer<typeof applyingRefSchema>;
export const verificationFailureSchema=z.union([
  object({kind:z.literal('verdict'),jobId:idSchema,note:text}),
  object({kind:z.literal('ancestry'),comparisons:z.array(object({ancestor:shaRefSchema,descendant:shaRefSchema})).min(1)}),
]);
export const deliveryAnchorSchema=z.union([
  object({kind:z.literal('none')}),object({kind:z.literal('adopted'),head:shaSchema}),object({kind:z.literal('submitted'),workId:idSchema,head:shaSchema}),
]);
export type DeliveryAnchor=z.infer<typeof deliveryAnchorSchema>;
export const ownerPhaseSchema=z.union([
  object({kind:z.literal('none')}),object({kind:z.literal('open'),workId:idSchema}),
  object({kind:z.literal('terminal'),workId:idSchema,result:z.enum(['submitted','noCode','replacePr','sourceRestored','externallyMerged'])}),
]);
export type OwnerPhase=z.infer<typeof ownerPhaseSchema>;
export const sourceChangeCauseSchema=z.union([
  object({reason:z.literal('bodyChanged'),contractRevision:revision}),object({reason:z.literal('noCodeBodyChanged'),contractRevision:revision}),
  ...(['prMissing','branchMissing'] as const).map(reason=>object({reason:z.literal(reason),binding:registeredBindingSchema,baseline:deliveryAnchorSchema,phase:ownerPhaseSchema})),
  ...(['prClosed','targetOrMaintenanceChanged'] as const).map(reason=>object({reason:z.literal(reason),binding:registeredBindingSchema,baseline:deliveryAnchorSchema,phase:ownerPhaseSchema,updatedAt:millisSchema})),
]);
export type SourceChangeCause=z.infer<typeof sourceChangeCauseSchema>;
export const caseSubjectSchema = z.union([
  object({kind:z.literal('claim'),ticket:text,revision,claim:claimSchema}),object({kind:z.literal('findings'),jobId:idSchema,gateKind:gateKindSchema,stamp:gateStampSchema,note:text}),
  object({kind:z.literal('closed'),member:issueRefSchema,event:lifecycleEventSchema.nullable(),bodyHash:hashSchema}),object({kind:z.literal('reopened'),member:issueRefSchema,event:lifecycleEventSchema,bodyHash:hashSchema}),
  object({kind:z.literal('checks'),member:issueRefSchema,responseWorkId:idSchema,failures:z.array(checkFailureSchema).min(1)}),
  object({kind:z.literal('postMerge'),cause:verificationFailureSchema}),object({kind:z.literal('closure'),cause:verificationFailureSchema}),
  object({kind:z.literal('orphanDesign'),requirement:designRequirementSchema}),object({kind:z.literal('migration'),original:issueRefSchema,commit:shaRefSchema}),
  object({kind:z.literal('agendaGap'),issue:issueRefSchema,bodyHash:hashSchema}),object({kind:z.literal('effectFailure'),effectId:idSchema}),
  object({kind:z.literal('unexpectedSourceChange'),member:issueRefSchema,cause:sourceChangeCauseSchema,bodyHash:hashSchema}),
  object({kind:z.literal('hostPrecondition'),requestId:idSchema,effectId:idSchema.nullable(),attempt:ordinal,reason:z.enum(['seatNonresponse','planMode','async','isolation','binding'])}),
  object({kind:z.literal('stall'),obligations:z.array(domainRefSchema).min(1),reason:text}),
]);
export type CaseSubject = z.infer<typeof caseSubjectSchema>;
export const caseStateSchema = z.union([
  object({kind:z.literal('open')}),object({kind:z.literal('applying'),decision:caseDecisionSchema,required:z.array(applyingRefSchema).min(1)}),
  object({kind:z.literal('awaitingExternal'),wait:z.union([object({kind:z.literal('caseSource'),condition:sourceConditionSchema}), object({kind:z.literal('effect'),effectId:idSchema})])}),
  object({kind:z.literal('resolved'),result:z.union([caseDecisionSchema,object({kind:z.literal('effectConfirmed'),effectId:idSchema})])}),object({kind:z.literal('cancelled'),reason:z.enum(['externallyMerged','sourceEventSuperseded','parentRemoved','gateCancelledBeforeReply'])}),
]);
export const decisionCaseSchema = object({id:idSchema,contentVersion:revision,context:contextSchema,subject:caseSubjectSchema,evidence:text,bodyBaselines:z.array(object({issue:issueRefSchema,hash:hashSchema})),state:caseStateSchema,openedBy:claimReceiptSchema.nullable(),receipt:receiptSchema.nullable()});
export type DecisionCase = z.infer<typeof decisionCaseSchema>;
export const draftSchema = object({id:idSchema,caseId:idSchema,purpose:z.enum(['split','correction','outsideAgenda','designOnly','migration']),spec:draftSpecSchema,position:positionSchema,scope:contextSchema,parent:issueRefSchema.nullable(),requirement:designRequirementSchema.nullable(),creationEffectId:idSchema,attachmentEffectIds:z.array(idSchema),state:z.union([
  object({kind:z.literal('proposed')}),object({kind:z.literal('registered'),issue:issueRefSchema}),object({kind:z.literal('placed'),member:issueRefSchema}),
])});
export type Draft = z.infer<typeof draftSchema>;
export const amendmentIntentSchema = object({id:idSchema,caseId:idSchema,affected:z.array(issueRefSchema).min(1),state:z.union([
  object({kind:z.literal('pending'),bodyEdits:z.array(bodyEditSchema),designWork:idSchema.nullable(),insertions:z.array(z.union([object({kind:z.literal('draft'),draftId:idSchema}), object({kind:z.literal('existing'),entry:entrySchema,position:positionSchema})])),requiredEffectIds:z.array(idSchema)}),
  object({kind:z.literal('effective'),revision}),
])});
export type AmendmentIntent = z.infer<typeof amendmentIntentSchema>;
export const seatRequestSchema = object({id:idSchema,role:z.enum(['owner','review','accept','postMerge','closure']),context:contextSchema,obligation:z.union([object({kind:z.literal('owner'),member:issueRefSchema}),object({kind:z.literal('gate'),jobId:idSchema})]),name:z.string().regex(/^Rt[A-Za-z0-9]+$/),assignment:text,runId:idSchema,binding:z.union([
  object({kind:z.literal('unbound')}),object({kind:z.literal('bound'),agentId:text,sessionId:text,parentId:text}),
]),receipt:receiptSchema.nullable()});
export type SeatRequest = z.infer<typeof seatRequestSchema>;
export const actionSchema = z.union([
  object({kind:z.literal('publishPr'),member:issueRefSchema,submission:acceptedSubmissionSchema,headRepo:repoSchema,target:targetSchema,pr:prRefSchema.nullable(),expectedBodyHash:hashSchema.nullable(),body:text}),
  object({kind:z.literal('createIssue'),draftId:idSchema,spec:draftSpecSchema,actor:text}),
  object({kind:z.literal('attachChild'),owner:z.union([object({kind:z.literal('draft'),draftId:idSchema}), object({kind:z.literal('insertion'),caseId:idSchema,insertion:existingInsertionSchema})]),parent:issueRefSchema,child:issueRefSchema}),
  object({kind:z.literal('replaceBody'),amendmentId:idSchema,edit:bodyEditSchema}),
  object({kind:z.literal('setIssueState'),issue:issueRefSchema,open:z.boolean(),afterEvent:lifecycleEventSchema.nullable(),bodyHash:hashSchema}),
  object({kind:z.literal('rerunChecks'),pr:prRefSchema,repo:repoSchema,workflowRunId:revision,previousAttempt:revision,head:shaSchema}),
  object({kind:z.literal('merge'),member:issueRefSchema,pr:prRefSchema,head:shaSchema,target:targetSchema,review:gateStampSchema,accept:gateStampSchema,predecessors:z.array(object({unitId:idSchema,jobId:idSchema,members:z.array(terminalMemberStampSchema)}))}),
  object({kind:z.literal('wake'),requestId:idSchema,ticket:text,revision,holder:text,runId:idSchema,body:text}),
]);
export type Action = z.infer<typeof actionSchema>;
export const effectResultSchema = z.union([
  object({kind:z.literal('published'),pr:prRefSchema}),object({kind:z.literal('created'),issue:issueRefSchema}),
  object({kind:z.literal('attached'),parent:issueRefSchema,child:issueRefSchema}),object({kind:z.literal('bodyReplaced'),issue:issueRefSchema,hash:hashSchema}),
  object({kind:z.literal('issueState'),issue:issueRefSchema,open:z.boolean(),event:lifecycleEventSchema.nullable()}),
  object({kind:z.literal('rerun'),repo:repoSchema,workflowRunId:revision,attempt:revision}),
  object({kind:z.literal('merged'),pr:prRefSchema,merge:shaRefSchema,at:millisSchema}),
  object({kind:z.literal('delivered'),agentId:text,messageId:text,outcome:z.enum(['injected','woken'])}),
]);
export type EffectResult = z.infer<typeof effectResultSchema>;
export const effectWaitSchema = z.union([object({kind:z.literal('source'),condition:sourceConditionSchema}),object({kind:z.literal('rateLimitReset'),resetAt:millisSchema})]);
export type EffectWait = z.infer<typeof effectWaitSchema>;
export const effectCancelReasonSchema = z.enum(['preconditionChanged','targetBecameInapplicable','superseded','holderAbsent','sourceAlreadyAdvanced']);
export type EffectCancelReason = z.infer<typeof effectCancelReasonSchema>;
export const retryProvenanceSchema = z.union([
  object({kind:z.literal('preflight'),error:portErrorSchema,wait:effectWaitSchema.nullable()}),
  object({kind:z.literal('call'),startedAt:millisSchema,received:createdResultSchema.nullable(),error:portErrorSchema,wait:effectWaitSchema.nullable()}),
  object({kind:z.literal('delivery'),effectId:idSchema}),
]);
export type RetryProvenance = z.infer<typeof retryProvenanceSchema>;
export const readyProvenanceSchema = z.union([
  object({kind:z.literal('initial')}),
  object({kind:z.literal('accepted'),caseId:idSchema,acceptedAt:millisSchema,previous:retryProvenanceSchema}),
]);
export const effectSchema = object({id:idSchema,scope:contextSchema,action:actionSchema,attempt:ordinal,authorization:z.enum(['initial','retry','retryAfterAbsence','retryHost']),state:z.union([
  object({kind:z.literal('ready'),provenance:readyProvenanceSchema}),object({kind:z.literal('executing'),attempt:revision,startedAt:millisSchema}),
  object({kind:z.literal('failed'),attempt:ordinal,provenance:z.union([object({kind:z.literal('preflight')}), object({kind:z.literal('call'),startedAt:millisSchema})]),received:createdResultSchema.nullable(),error:portErrorSchema,wait:effectWaitSchema.nullable()}),object({kind:z.literal('uncertain'),attempt:revision,startedAt:millisSchema,received:createdResultSchema.nullable(),error:portErrorSchema,wait:effectWaitSchema.nullable()}),
  object({kind:z.literal('confirmed'),result:effectResultSchema}),object({kind:z.literal('cancelled'),reason:effectCancelReasonSchema}),
])});
export type Effect = z.infer<typeof effectSchema>;
export const reportWorkSchema = object({id:idSchema,contentVersion:revision,state:z.union([object({kind:z.literal('requested')}),object({kind:z.literal('reported'),summary:text,externalMerges:z.array(ownerTerminalSchema),receipt:receiptSchema})])});
export type ReportWork = z.infer<typeof reportWorkSchema>;
export const agendaSchema = object({id:agendaIdSchema,version:revision,nextId:revision,convenedAt:millisSchema,lifecycle:z.enum(['active','completed']),units:z.array(unitSchema).min(1),parent:issueRefSchema.nullable(),closure:gateJobSchema.nullable(),rulings:z.array(gateRulingSchema),cases:z.array(decisionCaseSchema),designWorks:z.array(designWorkSchema),drafts:z.array(draftSchema),amendments:z.array(amendmentIntentSchema),effects:z.array(effectSchema),requests:z.array(seatRequestSchema),run:z.union([object({kind:z.literal('detached')}),object({kind:z.literal('attached'),id:idSchema,mainAgentId:text,mainSessionId:text})]),report:reportWorkSchema.nullable()});
export type Agenda = z.infer<typeof agendaSchema>;
export const eventSchema = z.union([
  object({kind:z.literal('hostObserved')}),
  object({kind:z.literal('observe')}),object({kind:z.literal('reply'),caller:callerSchema,ticket:text,revision,payload:protocolReplySchema,acceptedAt:millisSchema}),
  object({kind:z.literal('mainNoCode'),caller:callerSchema,member:issueRefSchema,bodyHash:hashSchema,reason:text,acceptedAt:millisSchema}),
  object({kind:z.literal('effectSatisfied'),id:idSchema,result:effectResultSchema}),object({kind:z.literal('effectStarted'),id:idSchema,attempt:revision,startedAt:millisSchema}),
  object({kind:z.literal('effectConfirmed'),id:idSchema,attempt:revision,result:effectResultSchema}),object({kind:z.literal('effectFailed'),id:idSchema,attempt:ordinal,error:portErrorSchema,outcome:z.enum(['knownFailed','uncertain']),received:createdResultSchema.optional()}),
  object({kind:z.literal('effectCancelled'),id:idSchema,reason:effectCancelReasonSchema}),object({kind:z.literal('resume'),runId:idSchema,operatorConfirmedOriginalSessionEnded:z.literal(true)}),
]);
export type Event = z.infer<typeof eventSchema>;
export const domainErrorKindSchema = z.enum(['unauthorized','wrongTicketKind','wrongContext','unknownTicket','staleRevision','superseded','replyConflict','pendingClaim','premiseChanged','missingDesignCommit','invalidDecision','sourceUnavailable','unsupportedFormat','ownershipBlocked','ownershipConflict','roundtableInactive','notFound','agendaRequired']);
export type DomainError = {kind:z.infer<typeof domainErrorKindSchema>;message:string;current:Ticket|null};
export type ParseError = {path:string;reason:string};
export type Transition = {kind:'same';reply:ReplyResult|null}|{kind:'rejected';error:DomainError}|{kind:'next';state:Agenda;reply:ReplyResult|null};
export type Ticket = {agendaId:AgendaId;id:TicketId;revision:number;holder:{kind:'main'}|{kind:'seat';requestId:RequestId;agentId:string|null};context:Context;brief:string;allowedReplies:readonly ProtocolReply['kind'][];runDisposition:'mustRun'|'mayWait';attentionRequired:boolean};
