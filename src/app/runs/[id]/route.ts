import { existsSync, readFileSync } from 'node:fs';
import { NextResponse } from 'next/server';
import { getDb } from '@/core/db/client';
import { getRun } from '@/core/work/runs';
import { displayLines } from '@/core/work/stream';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(getDb(), Number(id));
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  const lines = existsSync(run.logPath) ? readFileSync(run.logPath, 'utf8').split('\n') : [];
  return NextResponse.json({ outcome: run.outcome, summary: run.summary, lines: displayLines(lines, 30) });
}
