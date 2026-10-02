#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * The `hh` command. It is plain JavaScript so that package managers can link
 * it at install time, before `pnpm build` compiles src/ to dist/. It runs
 * unconditionally instead of checking that it is the main module: installed
 * commands reach it through symbolic links and shims, whose paths differ from
 * this file's own.
 */
import { main } from "../dist/src/main.js";

const code = await main(process.argv.slice(2));
if (code !== undefined) process.exitCode = code;
