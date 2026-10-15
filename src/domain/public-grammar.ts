import type { z as facadeZ, ZodLikeSchema } from '@oh-my-pi/omptype/zod';

type PublicZ = Pick<typeof facadeZ, 'string'|'number'|'boolean'|'literal'|'enum'|'union'|'array'|'object'>;

function questionReadings(values:string[]):[string,string] {
  const first=values[0],second=values[1];
  if(first===undefined||second===undefined)throw new Error('Validated question readings must contain exactly two strings');
  return [first,second];
}

/** Each caller constructs its own nodes; host and local schema objects never cross. */
export function buildPublicGrammar(z:PublicZ) {
  const object=<const S extends Readonly<Record<string,ZodLikeSchema<unknown>>>>(shape:S)=>z.object(shape).strict();
  const text=z.string().min(1);
  const ordinal=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
  const revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
  const millisSchema=ordinal;
  const shaSchema=z.string().regex(/^[a-f0-9]{40,64}$/);
  const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
  const idSchema=text;
  const agendaIdSchema=z.string().regex(/^(?:00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
  const repoSchema=object({owner:text,name:text});
  const issueRefSchema=object({repo:repoSchema,number:revision});
  const prRefSchema=issueRefSchema;
  const shaRefSchema=object({repo:repoSchema,sha:shaSchema});
  const targetSchema=object({repo:repoSchema,base:text});
  const entrySchema=object({issue:issueRefSchema,target:targetSchema,designOnly:z.boolean(),adoptPr:prRefSchema.nullable()});
  const conveneSchema=object({op:z.literal('convene'),mode:z.enum(['plan','execute']),parent:issueRefSchema.nullable(),entries:z.array(entrySchema).min(1)});
  const positionSchema=z.union([
    object({kind:z.literal('before'),unitId:idSchema}),object({kind:z.literal('after'),unitId:idSchema}),
    object({kind:z.literal('correctionOf'),unitId:idSchema}),object({kind:z.literal('outsideAgenda')}),
  ]);
  const draftSpecSchema=object({repo:repoSchema,title:text,body:text,target:targetSchema,designOnly:z.boolean()});
  const existingInsertionSchema=object({kind:z.literal('existing'),entry:entrySchema,position:positionSchema});
  const insertionSchema=z.union([existingInsertionSchema,object({kind:z.literal('draft'),draft:draftSpecSchema,position:positionSchema})]);
  const bodyEditSchema=object({issue:issueRefSchema,expectedHash:hashSchema,body:z.string()});
  const designRouteSchema=z.union([
    object({kind:z.literal('defaultFirst'),repo:repoSchema}),object({kind:z.literal('withPr'),member:issueRefSchema}),
    object({kind:z.literal('future'),carrier:z.union([issueRefSchema,draftSpecSchema])}),
  ]);
  const amendmentSchema=z.union([
    object({kind:z.literal('designGap'),affected:z.array(issueRefSchema).min(1),bodyEdits:z.array(bodyEditSchema),route:designRouteSchema}),
    object({kind:z.literal('acceptanceMethod'),affected:z.array(issueRefSchema).min(1),bodyEdits:z.array(bodyEditSchema).min(1),transfer:insertionSchema}),
  ]);
  const sourceConditionSchema=z.union([
    object({kind:z.literal('checksSettled'),pr:prRefSchema,runId:revision}),object({kind:z.literal('bodyChanged'),issue:issueRefSchema,fromHash:hashSchema}),
    object({kind:z.literal('commitLanded'),commit:shaRefSchema}),object({kind:z.literal('issueState'),issue:issueRefSchema,open:z.boolean()}),
    object({kind:z.literal('prChanged'),pr:prRefSchema,fromHead:shaSchema}),object({kind:z.literal('mainRelease'),reason:text}),
  ]);
  const createdResultSchema=z.union([object({kind:z.literal('pr'),pr:prRefSchema}),object({kind:z.literal('issue'),issue:issueRefSchema})]);
  const caseDecisionSchema=z.union([
    object({kind:z.literal('amend'),amendment:amendmentSchema}),object({kind:z.literal('confirmNoCode'),bodyHash:hashSchema,reason:text,issue:issueRefSchema.optional()}),
    ...(['answer','outOfDomain','implementationDefect','refute','upholdOwner','upholdMain','reject','fix','reverify','keepWork'] as const).map(kind=>object({kind:z.literal(kind),basis:text})),
    object({kind:z.literal('split'),bodyEdit:bodyEditSchema,insertions:z.array(insertionSchema).min(1)}),
    object({kind:z.literal('replacePr'),pr:prRefSchema,reason:text}),object({kind:z.literal('waitExternal'),condition:sourceConditionSchema,reason:text}),
    object({kind:z.literal('outOfScope'),draft:draftSpecSchema}),
    ...(['reopen','restore','revokeNoCode'] as const).map(kind=>object({kind:z.literal(kind),eventId:text})),
    object({kind:z.literal('correct'),insertion:insertionSchema}),object({kind:z.literal('correct'),draft:draftSpecSchema}),object({kind:z.literal('rerun'),runId:revision}),
    object({kind:z.literal('correctDesign'),insertion:insertionSchema,clauses:z.array(text).min(1)}),
    object({kind:z.literal('assignCarrier'),commit:shaRefSchema,carrier:z.union([issueRefSchema,draftSpecSchema])}),
    object({kind:z.literal('assignMigration'),original:issueRefSchema,migration:z.union([issueRefSchema,draftSpecSchema])}),
    object({kind:z.literal('includeExisting'),issue:issueRefSchema,position:positionSchema}),
    object({kind:z.literal('retry'),effectId:idSchema,attempt:ordinal}),object({kind:z.literal('adoptResult'),effectId:idSchema,result:createdResultSchema}),
    object({kind:z.literal('retryAfterAbsence'),effectId:idSchema,attempt:ordinal}),object({kind:z.literal('rebaseEdit'),effectId:idSchema,expectedHash:hashSchema,body:z.string()}),
    object({kind:z.literal('sourceRestored'),acceptedHead:shaSchema}),object({kind:z.literal('acceptExternalMerge'),pr:prRefSchema}),
    object({kind:z.literal('retryHost'),requestId:idSchema}),
  ]);
  const readingsSchema=z.array(text).min(2).max(2).transform(questionReadings);
  const claimSchema=z.union([
    object({kind:z.literal('question'),reproduction:text,readings:readingsSchema,earliestGap:text,proposal:text}),
    object({kind:z.literal('noCode'),evidence:text}),object({kind:z.literal('split'),proposal:text}),object({kind:z.literal('blocked'),category:text,attempts:text}),
  ]);
  const submitSchema=object({kind:z.literal('submit'),branch:text,head:shaSchema,title:text,body:text,template:z.enum(['fourLayer','docOnly']),retryNote:text.nullable()});
  const protocolReplySchema=z.union([
    submitSchema,object({kind:z.literal('claim'),claim:claimSchema}),object({kind:z.literal('verdict'),ok:z.boolean(),note:text}),
    object({kind:z.literal('spawned'),agentId:text}),object({kind:z.literal('designCommit'),commit:shaRefSchema}),
    object({kind:z.literal('report'),summary:text}),object({kind:z.literal('decision'),decision:caseDecisionSchema}),
  ]);
  const portInputSchema=z.union([
    conveneSchema,object({op:z.literal('resume'),agenda:idSchema,operatorConfirmedOriginalSessionEnded:z.literal(true)}),
    object({op:z.literal('tickets'),agenda:idSchema.optional()}),object({op:z.literal('noCode'),member:issueRefSchema,bodyHash:hashSchema,reason:text}),
    object({op:z.literal('reply'),ticket:z.string().regex(/^(work|gate|case|spawn):.+$/),revision,reply:protocolReplySchema}),
  ]);
  const toolParametersSchema=object({input:portInputSchema});
  return {text,ordinal,revision,millisSchema,shaSchema,hashSchema,idSchema,agendaIdSchema,repoSchema,issueRefSchema,prRefSchema,shaRefSchema,targetSchema,entrySchema,conveneSchema,positionSchema,draftSpecSchema,existingInsertionSchema,insertionSchema,bodyEditSchema,designRouteSchema,amendmentSchema,sourceConditionSchema,createdResultSchema,caseDecisionSchema,claimSchema,submitSchema,protocolReplySchema,portInputSchema,toolParametersSchema};
}
