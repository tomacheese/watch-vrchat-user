import fs from 'node:fs'

// Load the environment before modules that read path or Cookie settings.
if (fs.existsSync('.env')) process.loadEnvFile('.env')
