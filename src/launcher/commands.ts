import type {Result} from '../domain/model.ts';
import {type LauncherStatus,installLauncher,launcherLogPaths,launcherStatus,uninstallLauncher} from './launch-agent.ts';
import {LAUNCHER_PORT} from './link.ts';

export const LAUNCHER_USAGE='Usage: omp-roundtable-launcher install | uninstall | status';

export function describeLauncher(state:LauncherStatus):string {
  const logs=launcherLogPaths();
  return [
    `installed: ${state.installed?'yes':'no'} (${state.plist})`,
    `launchd loaded: ${state.loaded?'yes':'no'}`,
    `127.0.0.1:${LAUNCHER_PORT} answering: ${state.responding?'yes':'no'}`,
    `logs: ${logs.out}, ${logs.err}`,
  ].join('\n');
}

/**
 * The launcher is a separate local process, so installing it is never part of
 * starting a coordinator: this command is the whole user interface to it.
 */
export async function launcherCommand(args:readonly string[]):Promise<Result<string,string>> {
  const command=args[0]??'status';
  if(command==='install'){
    const result=await installLauncher();
    return result.ok?{ok:true,value:`Roundtable launcher installed.\ninterpreter: ${result.value.interpreter}\n${describeLauncher(result.value.status)}`}:{ok:false,error:result.error.message};
  }
  if(command==='uninstall'){
    const result=await uninstallLauncher();
    return result.ok?{ok:true,value:`Roundtable launcher uninstalled.\n${describeLauncher(result.value)}`}:{ok:false,error:result.error.message};
  }
  if(command==='status'){
    const result=await launcherStatus();
    return result.ok?{ok:true,value:describeLauncher(result.value)}:{ok:false,error:result.error.message};
  }
  return {ok:false,error:LAUNCHER_USAGE};
}
