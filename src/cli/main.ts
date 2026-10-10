import { CommanderError } from 'commander';
import { getDb } from '@/core/db/client';
import { buildProgram } from './program';

const program = buildProgram(getDb(), { out: (s) => console.log(s), err: (s) => console.error(s) });
program.parseAsync(process.argv).catch((err) => {
  if (err instanceof CommanderError) process.exit(err.exitCode);
  throw err;
});
