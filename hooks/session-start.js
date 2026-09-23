#!/usr/bin/env node
import { runHook } from '../dist/hook.js';

runHook('session-start').then((code) => {
  process.exitCode = code ?? 0;
});