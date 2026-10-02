import { AiCompletion, AiProvider, AiRequest } from './ai-provider';

interface JsonProperty {
  type?: string | string[];
  enum?: (string | null)[];
}

/**
 * Deterministic stand-in for a model, for tests and local demos without an API key
 * (AI_PROVIDER=fake; refused in production). It answers from the requested JSON schema
 * and simple text heuristics:
 * - enum: the first allowed value that appears in the data (so "crash bug" → "bug"),
 *   otherwise the first value
 * - fields: a "name: value" line in the data, otherwise a type-appropriate default
 * - summary: the first 20 words
 */
export class FakeAiProvider implements AiProvider {
  readonly name = 'fake';

  async complete(request: AiRequest): Promise<AiCompletion> {
    request.signal.throwIfAborted();
    const data = /<data>\n([\s\S]*)\n<\/data>/.exec(request.prompt)?.[1] ?? '';
    const schema = request.jsonSchema as {
      properties?: Record<string, JsonProperty>;
      required?: string[];
    };
    const required = new Set(schema.required ?? []);
    const json: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      json[name] = fakeValue(name, property, data, required.has(name));
    }
    const output = JSON.stringify(json);
    return {
      json,
      usage: {
        inputTokens: Math.ceil((request.system.length + request.prompt.length) / 4),
        outputTokens: Math.ceil(output.length / 4),
        model: 'fake',
      },
    };
  }
}

function fakeValue(name: string, property: JsonProperty, data: string, required: boolean) {
  const types = [property.type].flat();
  const labelled = new RegExp(`^\\s*${name}\\s*[:=]\\s*(.+)$`, 'im').exec(data)?.[1]?.trim();
  const words = data.split(/\s+/).filter(Boolean);

  if (property.enum) {
    const values = property.enum.filter((v): v is string => typeof v === 'string');
    const lower = (labelled ?? data).toLowerCase();
    return values.find((v) => lower.includes(v.toLowerCase())) ?? (required ? values[0] : null);
  }
  if (name === 'summary') return words.slice(0, 20).join(' ') || 'Empty input.';
  if (name === 'confidence') return 0.9;
  if (types.includes('number')) {
    const match = /-?\d+(\.\d+)?/.exec(labelled ?? data);
    return match ? Number(match[0]) : required ? 0 : null;
  }
  if (types.includes('boolean')) {
    if (labelled) return /^(true|yes|1)$/i.test(labelled);
    return required ? false : null;
  }
  return labelled ?? (required ? words.slice(0, 10).join(' ') : null);
}
