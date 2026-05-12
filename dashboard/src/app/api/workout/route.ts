import { NextRequest, NextResponse } from 'next/server';
import { parseWorkout, toggleChecklist, logSet, logBodyweight } from '@/lib/vault/workout';

export const dynamic = 'force-dynamic';

export async function GET() {
  const workout = parseWorkout();
  if (!workout) {
    return NextResponse.json({ error: 'No workout file found' }, { status: 404 });
  }
  // Strip raw from response
  const { raw: _, ...data } = workout;
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { action } = body;

  if (action === 'toggle') {
    const ok = toggleChecklist(body.lineIndex);
    return NextResponse.json({ ok });
  }

  if (action === 'logSet') {
    const ok = logSet(body.lineIndex, body.value);
    return NextResponse.json({ ok });
  }

  if (action === 'bodyweight') {
    const ok = logBodyweight(body.value);
    return NextResponse.json({ ok });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
