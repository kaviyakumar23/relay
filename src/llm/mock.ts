import type { z } from 'zod';
import type { LlmProvider, ParseRequest } from './provider';
import { parseWithRepair } from './repair';

// Deterministic provider for hermetic tests and `npm run demo`. A responder maps a
// request to a raw object, which is validated through the SAME Zod boundary as the
// real providers — so tests exercise validation + the repair path without network.
export type MockResponder = (req: ParseRequest<z.ZodType>) => unknown | unknown[];

export class MockLlm implements LlmProvider {
  readonly name = 'mock' as const;
  private calls = 0;

  constructor(private readonly responder: MockResponder) {}

  get callCount(): number {
    return this.calls;
  }

  async parse<T extends z.ZodType>(req: ParseRequest<T>): Promise<z.infer<T>> {
    // A responder may return an array to simulate a first-bad-then-good repair.
    const scripted = this.responder(req as ParseRequest<z.ZodType>);
    const sequence = Array.isArray(scripted) ? scripted : [scripted];
    let idx = 0;
    return parseWithRepair(req.schema, req.schemaName, async () => {
      this.calls += 1;
      const value = sequence[Math.min(idx, sequence.length - 1)];
      idx += 1;
      return value;
    });
  }
}
