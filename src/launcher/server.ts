import {createServer} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {type Runner,run} from './exec.ts';
import {LAUNCHER_PORT,isUserNavigation,resolveTarget} from './link.ts';
import {launch} from './tern.ts';

export type LauncherOutcome={kind:'launched';via:'tab'|'window'}|{kind:'focused';block:string}|{kind:'rejected';reason:string}|{kind:'frontendFailed';output:string};
export type LauncherOptions={port?:number;runner?:Runner;log?:(entry:Readonly<Record<string,unknown>>)=>void};
export type Launcher={port:number;close:()=>Promise<void>};

function escapeHtml(value:string):string {
  return value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]??character));
}

function header(request:IncomingMessage,name:string):string|undefined {
  const value=request.headers[name];
  return Array.isArray(value)?value[0]:value;
}

/** One page per request states the single observable end of that request. */
function renderPage(outcome:LauncherOutcome,url:string):{status:number;title:string;body:string} {
  switch(outcome.kind){
    case 'launched':
      return {status:200,title:'launched',body:`<p>Tern is running <code>omp --roundtable</code> for <em>${escapeHtml(url)}</em>${outcome.via==='window'?' in a new window':' in a new tab'}.</p>`};
    case 'focused':
      return {status:200,title:'focused',body:`<p>Tern already holds live coordinator block <code>${escapeHtml(outcome.block)}</code> for this issue; it is focused now and no second process was started.</p>`};
    case 'rejected':
      return {status:400,title:'rejected',body:`<p>Nothing was started: ${escapeHtml(outcome.reason)}.</p>`};
    case 'frontendFailed':
      return {status:502,title:'frontendFailed',body:`<p>Tern could not start the coordinator.</p><pre>${escapeHtml(outcome.output)}</pre>`};
  }
}

export async function serveLauncher(options:LauncherOptions={}):Promise<Launcher> {
  const port=options.port??LAUNCHER_PORT;
  const runner=options.runner??run;
  const log=options.log??((entry)=>{process.stdout.write(`${JSON.stringify(entry)}\n`);});

  const handle=async(request:IncomingMessage,response:ServerResponse):Promise<void>=>{
    const url=new URL(request.url??'/',`http://127.0.0.1:${port}`);
    const navigation={mode:header(request,'sec-fetch-mode'),user:header(request,'sec-fetch-user')};
    const received={at:new Date().toISOString(),method:request.method??null,url:request.url??null,
      secFetchMode:navigation.mode??null,secFetchUser:navigation.user??null,referer:header(request,'referer')??null,userAgent:header(request,'user-agent')??null};
    let outcome:LauncherOutcome;
    let reference:string|null=null;
    if(request.method!=='GET')outcome={kind:'rejected',reason:'Only a GET navigation is accepted'};
    else if(!isUserNavigation(navigation))outcome={kind:'rejected',reason:'The request is not a user click: Sec-Fetch-Mode: navigate with Sec-Fetch-User: ?1 is required'};
    else {
      const target=await resolveTarget({pathname:url.pathname,search:url.search});
      if(!target.ok)outcome=target.error;
      else {reference=target.value.reference;outcome=await launch(target.value,runner);}
    }
    const page=renderPage(outcome,request.url??'/');
    log({...received,reference,outcome:outcome.kind,
      detail:outcome.kind==='rejected'?outcome.reason:outcome.kind==='focused'?outcome.block:outcome.kind==='frontendFailed'?outcome.output:outcome.via});
    response.writeHead(page.status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>omp-roundtable launcher: ${escapeHtml(page.title)}</title></head><body><h1>${escapeHtml(page.title)}</h1>${page.body}</body></html>`);
  };

  const server=createServer((request,response)=>{
    handle(request,response).catch((error:unknown)=>{
      const message=error instanceof Error?error.message:'Unexpected launcher failure';
      const page=renderPage({kind:'frontendFailed',output:message},request.url??'/');
      log({at:new Date().toISOString(),url:request.url??null,outcome:'frontendFailed',detail:message});
      response.writeHead(page.status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>omp-roundtable launcher: ${escapeHtml(page.title)}</title></head><body><h1>${escapeHtml(page.title)}</h1>${page.body}</body></html>`);
    });
  });
  const listening=Promise.withResolvers<void>();
  const failed=(error:Error):void=>{listening.reject(new Error(`Cannot listen on 127.0.0.1:${port}: ${error.message}`));};
  server.once('error',failed);
  server.listen(port,'127.0.0.1',()=>{server.off('error',failed);listening.resolve();});
  await listening.promise;
  log({at:new Date().toISOString(),outcome:'listening',port});
  return {port,close:()=>{
    const closed=Promise.withResolvers<void>();
    server.close(error=>error?closed.reject(error):closed.resolve());
    return closed.promise;
  }};
}
