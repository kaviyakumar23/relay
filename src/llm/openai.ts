import OpenAI from 'openai';
import { z } from 'zod';
import { modelFor } from './models';
import { type LlmProvider, LlmRefusalError, type ParseRequest } from './provider';
import { parseWithRepair } from './repair';

// OpenAI structured output via forced tool use (robust across zod versions — the
// tool's parameters are a plain JSON Schema from zod's native z.toJSONSchema).
// The model MUST call the single tool; we validate its arguments against the Zod
// schema at the boundary (never trust free text).
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai' as const;
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async parse<T extends z.ZodType>(req: ParseRequest<T>): Promise<z.infer<T>> {
    const model = modelFor('openai', req.task);
    const jsonSchema = z.toJSONSchema(req.schema);

    return parseWithRepair(req.schema, req.schemaName, async (repairHint) => {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ];
      if (repairHint) messages.push({ role: 'user', content: repairHint });

      const res = await this.client.chat.completions.create({
        model,
        max_completion_tokens: req.maxTokens ?? 2048,
        messages,
        tools: [
          {
            type: 'function',
            function: {
              name: req.schemaName,
              description: `Return the ${req.schemaName} result.`,
              parameters: jsonSchema as Record<string, unknown>,
              strict: false,
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: req.schemaName } },
      });

      const choice = res.choices[0];
      if (choice?.finish_reason === 'content_filter') throw new LlmRefusalError('content_filter');
      const call = choice?.message.tool_calls?.[0];
      if (call?.type !== 'function') {
        throw new Error('openai: model did not call the structured-output tool');
      }
      return JSON.parse(call.function.arguments);
    });
  }
}
