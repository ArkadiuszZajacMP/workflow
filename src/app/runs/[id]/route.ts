import { NextResponse } from 'next/server';
import { getDb } from '@/core/db/client';
import { readLogTail } from '@/core/work/log-tail';
import { getRun } from '@/core/work/runs';
import { displayLines } from '@/core/work/stream';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runId = Number(id);
  if (!Number.isInteger(runId) || runId <= 0) return NextResponse.json({ error: 'Invalid run id' }, { status: 400 });
  const run = getRun(getDb(), runId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  return NextResponse.json({ outcome: run.outcome, summary: run.summary, lines: displayLines(readLogTail(run.logPath), 30) });
}
