#!/usr/bin/env node
import { runHook } from '../dist/hook.js';

runHook('user-prompt-submit').then((code) => {
  process.exitCode = code ?? 0;
});