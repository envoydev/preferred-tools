#!/usr/bin/env node
'use strict';
// Prints a fresh temp folder in the form this machine's Node resolves (mktemp -d gives a POSIX path that a native Windows
// Node cannot open). The walk keeps its inventory, answers and plan files in it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (require.main === module) process.stdout.write(`${fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'preferred-tools-'))}\n`);
