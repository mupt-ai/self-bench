#!/usr/bin/env node

import { runCli } from "./main.js";

await runCli(process.argv.slice(2));
