#!/usr/bin/env node

import { runCli } from "./cli/main.js";

await runCli(process.argv.slice(2));
