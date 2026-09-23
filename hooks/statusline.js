#!/usr/bin/env node
import { runHook } from '../dist/hook.js';

runHook('statusline').then((code) => {
  process.exitCode = code ?? 0;
});