// VS Code terminals set ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node.
import { spawn } from 'node:child_process'
import electron from 'electron'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env }).on('exit', (c) => process.exit(c ?? 0))
