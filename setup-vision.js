import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {pythonExecutable} from './core/runtime.js';
const root=path.dirname(fileURLToPath(import.meta.url));
const result=spawnSync(pythonExecutable(root),[path.join(root,'core','setup_vision.py')],{cwd:root,stdio:'inherit',windowsHide:true});
process.exitCode=result.status??1;
