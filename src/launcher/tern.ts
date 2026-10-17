import {z} from '@oh-my-pi/omptype/zod';
import {type Runner,run} from './exec.ts';
import type {LaunchTarget} from './link.ts';

/** `tern ls --json`, read only where a block can carry a coordinator command; every other field is ignored. */
const listingSchema=z.object({
  sessions:z.array(z.object({
    tabs:z.array(z.object({
      blocks:z.array(z.object({id:z.number(),live:z.boolean().optional(),args:z.array(z.string()).optional()})),
    })),
  })),
});

export type LaunchOutcome={kind:'launched';via:'tab'|'window'}|{kind:'focused';block:string}|{kind:'frontendFailed';output:string};

function describe(result:{code:number;stdout:string;stderr:string}):string {return result.stderr.trim()||result.stdout.trim()||`exit code ${result.code}`;}

/** Tern launches every block as `<shell> -c "<command>"`, so one launcher argument arrives as a fragment of one array entry; compare whitespace-separated, unquoted tokens rather than raw entries. */
function coordinatorTokens(args:readonly string[]):string[] {
  return args.flatMap(value=>value.split(/\s+/)).map(token=>token.replace(/^["']|["']$/g,'')).filter(token=>token.length>0);
}

/**
 * Tern owns existence: a live block already running the exact reference is the
 * coordinator for that issue. Nothing here keeps its own dedup record, so a
 * coordinator that exited simply stops matching and the next click starts one.
 */
export function liveCoordinatorBlock(listing:string,reference:string):string|null {
  let parsed:unknown;
  try {parsed=JSON.parse(listing);} catch {return null;}
  const read=listingSchema.safeParse(parsed);
  if(!read.success)return null;
  for(const session of read.data.sessions)for(const tab of session.tabs)for(const block of tab.blocks){
    if(block.live!==true)continue;
    const tokens=coordinatorTokens(block.args??[]);
    const carries=tokens.some((token,index)=>token==='--roundtable'&&tokens[index+1]===reference)||tokens.includes(`--roundtable=${reference}`);
    if(carries)return String(block.id);
  }
  return null;
}

/**
 * Start or reveal the coordinator for one issue link. `omp` is taken from PATH,
 * as the operator's own shell would resolve it, and the extension arrives
 * through the installed plugin rather than an `-e` flag that would load it twice.
 */
export async function launch(target:LaunchTarget,exec:Runner=run):Promise<LaunchOutcome> {
  const listing=await exec('tern',['ls','--json'],{});
  if(listing.code===0){
    const holder=liveCoordinatorBlock(listing.stdout,target.reference);
    if(holder!==null){
      const focused=await exec('tern',['focus',holder],{});
      return focused.code===0?{kind:'focused',block:holder}:{kind:'frontendFailed',output:`tern focus ${holder}: ${describe(focused)}`};
    }
    const tab=await exec('tern',['new','tab','--cwd',target.cwd,'--','omp','--roundtable',target.reference],{});
    if(tab.code===0)return {kind:'launched',via:'tab'};
    const opened=await exec('tern',['-e','omp','--roundtable',target.reference],{cwd:target.cwd});
    return opened.code===0?{kind:'launched',via:'window'}:{kind:'frontendFailed',output:`tern new tab: ${describe(tab)}\ntern -e (no window): ${describe(opened)}`};
  }
  const opened=await exec('tern',['-e','omp','--roundtable',target.reference],{cwd:target.cwd});
  return opened.code===0?{kind:'launched',via:'window'}:{kind:'frontendFailed',output:`tern ls: ${describe(listing)}\ntern -e (Tern not running): ${describe(opened)}`};
}
