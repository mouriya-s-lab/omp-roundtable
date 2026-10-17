import {describe, expect, test} from 'bun:test';
import {isUserNavigation,parseLinkPath,resolveTarget} from '../src/launcher/link.ts';
import {type RunResult,type Runner} from '../src/launcher/exec.ts';
import {launch,liveCoordinatorBlock} from '../src/launcher/tern.ts';

// The launcher's whole behaviour is: read a link, decide, call Tern. These
// checks drive that decision with a fake Tern and a real filesystem stat.

type Call={command:string;args:readonly string[];cwd:string|undefined};

function fakeRunner(responses:Readonly<Record<string,RunResult>>):{calls:Call[];runner:Runner} {
  const calls:Call[]=[];
  return {calls,runner:async(command,args,options)=>{
    calls.push({command,args,cwd:options.cwd});
    const response=responses[`${command} ${args.join(' ')}`];
    if(!response)throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    return response;
  }};
}

const ok=(stdout:string):RunResult=>({code:0,stdout,stderr:''});
const failed=(stderr:string):RunResult=>({code:1,stdout:'',stderr});

const listing=(blocks:readonly {id:number;live:boolean;args:readonly string[]}[]):string=>JSON.stringify({sessions:[{id:1,tabs:[{id:2,blocks}]}]});
const reference='Acme/roundtable#7';
const liveBlock={id:42,live:true,args:['--roundtable',reference]};

describe('link contract',()=>{
  test('accepts one frontend, one owner/repo and one issue number',()=>{
    const parsed=parseLinkPath('/tern/Acme/roundtable/issues/7');
    expect(parsed.ok).toBe(true);
    if(parsed.ok)expect(parsed.value).toEqual({repo:{owner:'Acme',name:'roundtable'},number:7});
  });

  test('rejects every path that is not one tern issue link',()=>{
    for(const path of ['/wezterm/Acme/roundtable/issues/7','/tern/Acme/roundtable/pulls/7','/tern/Acme/roundtable/issues/abc','/tern/Acme/roundtable/issues/0','/tern/Acme/roundtable','/tern/Acme/roundtable/issues/7/extra']){
      const parsed=parseLinkPath(path);
      expect(parsed.ok).toBe(false);
      if(!parsed.ok)expect(parsed.error.kind).toBe('rejected');
    }
  });

  test('serves only a user click navigation',()=>{
    expect(isUserNavigation({mode:'navigate',user:'?1'})).toBe(true);
    expect(isUserNavigation({mode:'navigate',user:undefined})).toBe(false);
    expect(isUserNavigation({mode:'cors',user:'?1'})).toBe(false);
    expect(isUserNavigation({mode:undefined,user:undefined})).toBe(false);
  });

  test('requires an existing absolute cwd and decodes it from the query',async()=>{
    const accepted=await resolveTarget({pathname:'/tern/Acme/roundtable/issues/7',search:'?cwd=%2Ftmp'});
    expect(accepted.ok).toBe(true);
    if(accepted.ok){expect(accepted.value.cwd).toBe('/tmp');expect(accepted.value.reference).toBe(reference);}
    for(const search of ['', '?cwd=relative/path','?cwd=%2Fnonexistent-omp-roundtable-check','?cwd=%2Fetc%2Fhosts']){
      const refused=await resolveTarget({pathname:'/tern/Acme/roundtable/issues/7',search});
      expect(refused.ok).toBe(false);
      if(!refused.ok)expect(refused.error.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('coordinator discovery and launch decision',()=>{
  test('matches only a live block already running the exact reference',()=>{
    expect(liveCoordinatorBlock(listing([liveBlock]),reference)).toBe('42');
    expect(liveCoordinatorBlock(listing([{...liveBlock,live:false}]),reference)).toBeNull();
    expect(liveCoordinatorBlock(listing([{id:9,live:true,args:['--roundtable','Acme/roundtable#8']}]),reference)).toBeNull();
    expect(liveCoordinatorBlock(listing([{id:9,live:true,args:[`--roundtable=${reference}`]}]),reference)).toBe('9');
    expect(liveCoordinatorBlock('not json',reference)).toBeNull();
  });

  test('focuses the live coordinator instead of starting a second process',async()=>{
    const {calls,runner}=fakeRunner({
      'tern ls --json':ok(listing([liveBlock])),
      'tern focus 42':ok(''),
    });
    const outcome=await launch({frontend:'tern',issue:{repo:{owner:'Acme',name:'roundtable'},number:7},reference,cwd:'/tmp'},runner);
    expect(outcome).toEqual({kind:'focused',block:'42'});
    expect(calls.map(call=>call.args.join(' '))).toEqual(['ls --json','focus 42']);
  });

  test('opens a coordinator tab in the link cwd when no live block matches',async()=>{
    const {calls,runner}=fakeRunner({
      'tern ls --json':ok(listing([])),
      'tern new tab --cwd /tmp -- omp --roundtable Acme/roundtable#7':ok(''),
    });
    const outcome=await launch({frontend:'tern',issue:{repo:{owner:'Acme',name:'roundtable'},number:7},reference,cwd:'/tmp'},runner);
    expect(outcome).toEqual({kind:'launched',via:'tab'});
    expect(calls[1]?.cwd).toBeUndefined();
  });

  test('opens a window in the link cwd when no window runs',async()=>{
    const {calls,runner}=fakeRunner({
      'tern ls --json':failed('no window'),
      'tern -e omp --roundtable Acme/roundtable#7':ok(''),
    });
    const outcome=await launch({frontend:'tern',issue:{repo:{owner:'Acme',name:'roundtable'},number:7},reference,cwd:'/tmp'},runner);
    expect(outcome).toEqual({kind:'launched',via:'window'});
    expect(calls[1]?.cwd).toBe('/tmp');
  });

  test('falls back to a window when a tab cannot be created',async()=>{
    const {runner}=fakeRunner({
      'tern ls --json':ok(listing([])),
      'tern new tab --cwd /tmp -- omp --roundtable Acme/roundtable#7':failed('no window to add a tab to'),
      'tern -e omp --roundtable Acme/roundtable#7':ok(''),
    });
    const outcome=await launch({frontend:'tern',issue:{repo:{owner:'Acme',name:'roundtable'},number:7},reference,cwd:'/tmp'},runner);
    expect(outcome).toEqual({kind:'launched',via:'window'});
  });

  test('reports the frontend output when Tern cannot start anything',async()=>{
    const {runner}=fakeRunner({
      'tern ls --json':failed('no session daemon'),
      'tern -e omp --roundtable Acme/roundtable#7':failed('tern: cannot open a window'),
    });
    const outcome=await launch({frontend:'tern',issue:{repo:{owner:'Acme',name:'roundtable'},number:7},reference,cwd:'/tmp'},runner);
    expect(outcome.kind).toBe('frontendFailed');
    if(outcome.kind==='frontendFailed')expect(outcome.output).toContain('tern: cannot open a window');
  });
});
