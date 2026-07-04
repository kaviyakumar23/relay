import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { modelFor } from './models';
import { type LlmProvider, LlmRefusalError, type ParseRequest } from './provider';
import { parseWithRepair } from './repair';

// Anthropic structured output via forced tool use (kept DNA). Same contract as the
// OpenAI provider — the tool's input_schema is zod's native JSON Schema, and we
// validate the tool input against the Zod schema at the boundary.
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async parse<T extends z.ZodType>(req: ParseRequest<T>): Promise<z.infer<T>> {
    const model = modelFor('anthropic', req.task);
    const jsonSchema = z.toJSONSchema(req.schema) as Record<string, unknown>;

    return parseWithRepair(req.schema, req.schemaName, async (repairHint) => {
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: req.user }];
      if (repairHint) messages.push({ role: 'user', content: repairHint });

      const res = await this.client.messages.create({
        model,
        max_tokens: req.maxTokens ?? 2048,
        system: req.system,
        messages,
        tools: [
          {
            name: req.schemaName,
            description: `Return the ${req.schemaName} result.`,
            input_schema: jsonSchema as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: req.schemaName },
      });

      if (res.stop_reason === 'refusal') throw new LlmRefusalError('refusal');
      const block = res.content.find((b) => b.type === 'tool_use');
      if (block?.type !== 'tool_use') {
        throw new Error('anthropic: model did not call the structured-output tool');
      }
      return block.input;
    });
  }
}
