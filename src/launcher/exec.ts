import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const runFile=promisify(execFile);
const commandTimeoutMs=30_000;

export type RunResult={code:number;stdout:string;stderr:string};
export type Runner=(command:string,args:readonly string[],options:{cwd?:string})=>Promise<RunResult>;

/** One place runs a local command for the launcher; a fake substitutes it in tests. */
export const run:Runner=async(command,args,options)=>{
  try {
    const {stdout,stderr}=await runFile(command,[...args],{encoding:'utf8',maxBuffer:1024*1024,timeout:commandTimeoutMs,...(options.cwd===undefined?{}:{cwd:options.cwd})});
    return {code:0,stdout,stderr};
  } catch(error) {
    // Node's execFile rejects with an ExecFileException whose payload the bun
    // type surface does not expose here; read the fields it does carry.
    const failure=error as {code?:number|string;killed?:boolean;stdout?:string;stderr?:string;message?:string};
    const message=failure.stderr?.trim()||(failure.killed===true?`${command} did not finish within ${commandTimeoutMs/1000} seconds`:'')||failure.message||'The command failed';
    return {code:typeof failure.code==='number'?failure.code:1,stdout:failure.stdout??'',stderr:message};
  }
};
