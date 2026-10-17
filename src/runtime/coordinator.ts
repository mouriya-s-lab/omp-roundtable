import {parseIssueReference,refKey} from '../domain/identity.ts';
import type {IssueRef,Result} from '../domain/model.ts';

export type CoordinatorIdentity={issue:IssueRef;reference:string};

/**
 * `--roundtable <owner>/<repo>#<number>` is the entire launch identity. It is
 * parsed here at the extension boundary, so the rest of the runtime only ever
 * sees a validated issue reference and never a process that can change roles.
 */
export function parseCoordinatorFlag(value:unknown):Result<CoordinatorIdentity,string> {
  if(typeof value!=='string')return {ok:false,error:'--roundtable must carry a value of the form <owner>/<repo>#<number>'};
  const parsed=parseIssueReference(value.trim());
  return parsed.ok?{ok:true,value:{issue:parsed.value,reference:refKey(parsed.value)}}:parsed;
}

/** What the startup check found: either the saved active agendas or why the check itself failed. */
export type StartupCheck={reference:string;agenda:string};

/** The one message that starts a coordinator's first turn; it carries the whole briefing, never a URL or a Tern argument. */
export function coordinatorBriefing(check:StartupCheck):string {
  return [
    `This OMP process is the Roundtable coordinator for ${check.reference}. The identity is fixed for the life of the process: there is no in-session switch into or out of Roundtable, and no operator instruction is needed to start.`,
    `Saved agendas found at startup: ${check.agenda}.`,
    `Start by reading ${check.reference} completely — body, comments, and sub-issue relations — and then decide the delivery yourself:`,
    `- nothing saved covers this issue: call roundtable {"input":{"op":"convene","mode":"plan"|"execute","parent":<issue reference or null>,"entries":[{"issue":<reference>,"target":{"repo":<reference>,"base":"<branch>"},"designOnly":<boolean>,"adoptPr":<pull request reference or null>}]}}, where plan returns the planned input for review and execute starts delivery;`,
    `- one saved active agenda must continue: call roundtable {"input":{"op":"resume","agenda":"<agenda id>","operatorConfirmedOriginalSessionEnded":true}} after confirming that its original process ended.`,
  ].join('\n\n');
}
