'use client';

import { useState, useTransition } from 'react';
import type { ActionResult } from '@/app/actions';

export function useActionRunner() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function run(fn: () => Promise<ActionResult>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.error) setError(result.error);
    });
  }
  return { pending, error, run };
}
