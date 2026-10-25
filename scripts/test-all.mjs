import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=readdirSync(new URL('../tests/',import.meta.url)).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tests/'+name);
for(const [command,args] of [[process.execPath,['--test',...files]],[process.platform==='win32'?'python':'python3',['-m','unittest','discover','-s','tests']]]){
 const result=spawnSync(command,args,{cwd:root,stdio:'inherit'});
 if(result.error){console.error(result.error.message);process.exit(1);}
 if(result.status!==0)process.exit(result.status||1);
}
