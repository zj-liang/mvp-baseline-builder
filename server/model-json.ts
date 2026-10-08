// Parse the entire response, and reject duplicate keys before JSON's last-value wins behavior.
export function parseModelJSON(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const stack: Array<{ keys: Set<string>; expectingKey: boolean } | null> = [];
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)) {
    const token = match[0], object = stack.at(-1);
    if (token === '{') stack.push({ keys: new Set(), expectingKey: true });
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && object) object.expectingKey = true;
    else if (token.startsWith('"') && object?.expectingKey) {
      const key = JSON.parse(token) as string;
      if (object.keys.has(key)) throw new Error('Duplicate model JSON key');
      object.keys.add(key); object.expectingKey = false;
    }
  }
  return value;
}
