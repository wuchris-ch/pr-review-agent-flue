import { ReviewValidationError } from './schema.js';

/**
 * The reply stopped early instead of being malformed.
 *
 * Worth separating: a truncated reply means the model ran out of output
 * budget, which is a configuration problem the operator can fix, while
 * malformed JSON means the model ignored the contract. Both used to report
 * as "invalid JSON", which hid a token limit behind an apparent compliance
 * failure.
 */
export class TruncatedOutputError extends ReviewValidationError {
  constructor() {
    super(
      'model output ended before the JSON object was complete, which means the reply hit its output token limit',
    );
    this.name = 'TruncatedOutputError';
  }
}

class StrictJsonScanner {
  private index = 0;

  constructor(private readonly text: string) {}

  /** Reject the input, reporting a clean end of input as truncation. */
  private fail(message: string): never {
    if (this.index >= this.text.length) {
      throw new TruncatedOutputError();
    }
    throw new ReviewValidationError(message);
  }

  scan(): void {
    this.skipWhitespace();
    if (this.peek() !== '{') {
      this.fail('model output must contain only one JSON object');
    }
    this.scanObject();
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      throw new ReviewValidationError(
        'model output contains trailing data or multiple JSON values',
      );
    }
  }

  private scanValue(): void {
    this.skipWhitespace();
    const character = this.peek();

    if (character === '{') {
      this.scanObject();
    } else if (character === '[') {
      this.scanArray();
    } else if (character === '"') {
      this.scanString();
    } else if (character === 't') {
      this.scanLiteral('true');
    } else if (character === 'f') {
      this.scanLiteral('false');
    } else if (character === 'n') {
      this.scanLiteral('null');
    } else if (character === '-' || (character !== undefined && /[0-9]/.test(character))) {
      this.scanNumber();
    } else {
      this.fail('model output contains invalid JSON');
    }
  }

  private scanObject(): void {
    this.expect('{');
    this.skipWhitespace();
    const keys = new Set<string>();

    if (this.peek() === '}') {
      this.index += 1;
      return;
    }

    while (true) {
      this.skipWhitespace();
      if (this.peek() !== '"') {
        this.fail('JSON object keys must be strings');
      }
      const key = this.scanString();
      if (keys.has(key)) {
        throw new ReviewValidationError('model output contains a duplicate JSON key');
      }
      keys.add(key);

      this.skipWhitespace();
      this.expect(':');
      this.scanValue();
      this.skipWhitespace();

      if (this.peek() === '}') {
        this.index += 1;
        return;
      }
      this.expect(',');
    }
  }

  private scanArray(): void {
    this.expect('[');
    this.skipWhitespace();
    if (this.peek() === ']') {
      this.index += 1;
      return;
    }

    while (true) {
      this.scanValue();
      this.skipWhitespace();
      if (this.peek() === ']') {
        this.index += 1;
        return;
      }
      this.expect(',');
    }
  }

  private scanString(): string {
    const start = this.index;
    this.expect('"');
    let escaped = false;

    while (this.index < this.text.length) {
      const character = this.text[this.index];
      this.index += 1;

      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        const token = this.text.slice(start, this.index);
        try {
          return JSON.parse(token) as string;
        } catch {
          throw new ReviewValidationError('model output contains invalid JSON');
        }
      } else if (character !== undefined && character.charCodeAt(0) < 0x20) {
        throw new ReviewValidationError('model output contains invalid JSON');
      }
    }

    throw new TruncatedOutputError();
  }

  private scanNumber(): void {
    const remaining = this.text.slice(this.index);
    const match = remaining.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) {
      this.fail('model output contains an invalid number');
    }
    this.index += match[0].length;
  }

  private scanLiteral(literal: string): void {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      this.fail('model output contains invalid JSON');
    }
    this.index += literal.length;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.peek() ?? '')) {
      this.index += 1;
    }
  }

  private expect(character: string): void {
    if (this.peek() !== character) {
      this.fail('model output contains invalid JSON');
    }
    this.index += 1;
  }

  private peek(): string | undefined {
    return this.text[this.index];
  }
}

export function parseStrictJson(text: string): unknown {
  if (!text.trim()) {
    throw new ReviewValidationError('model produced no output');
  }

  const trimmed = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;

  new StrictJsonScanner(candidate).scan();

  let value: unknown;
  try {
    value = JSON.parse(candidate) as unknown;
  } catch {
    throw new ReviewValidationError('model output contains invalid JSON');
  }

  return value;
}
