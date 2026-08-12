// Parse a Unity Catalog column `type_text` (e.g.
// "array<struct<name:string,amount:double>>") into a nested StructureField
// tree, mirroring the original app's infer_fields logic.

import type { ColumnType, StructureField } from './types.js';

const SCALAR_MAP: Record<string, string> = {
  string: 'string',
  varchar: 'string',
  char: 'string',
  binary: 'string',
  int: 'number',
  integer: 'number',
  bigint: 'number',
  smallint: 'number',
  tinyint: 'number',
  long: 'number',
  short: 'number',
  byte: 'number',
  float: 'number',
  double: 'number',
  decimal: 'number',
  numeric: 'number',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'date',
  timestamp_ntz: 'date',
  interval: 'string',
};

function scalarType(text: string): string {
  const base = text.trim().toLowerCase().split('(')[0].trim();
  return SCALAR_MAP[base] ?? 'string';
}

/**
 * Map a UC `type_text` to the report app's scalar ColumnType. Complex types
 * (array/struct/map) are treated as 'string' — they can be displayed but not
 * aggregated numerically.
 */
export function columnTypeFromText(typeText: string): ColumnType {
  const lower = typeText.trim().toLowerCase();
  if (lower.startsWith('array<') || lower.startsWith('struct<') || lower.startsWith('map<')) {
    return 'string';
  }
  const t = scalarType(typeText);
  return t === 'number' || t === 'boolean' || t === 'date' ? t : 'string';
}

/**
 * Split a comma-separated list at depth 0, ignoring commas nested inside
 * `<...>` (e.g. struct field lists) so nested generics are not broken apart.
 */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '<') depth++;
    else if (c === '>') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (start < inner.length) parts.push(inner.slice(start));
  return parts;
}

/** Extract the inner content between the first `<` and its matching `>`. */
function innerOf(text: string): string {
  const open = text.indexOf('<');
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '<') depth++;
    else if (text[i] === '>') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/** Parse a `name:type` struct field, respecting nested `<>`. */
function splitNameType(field: string): { name: string; type: string } {
  let depth = 0;
  for (let i = 0; i < field.length; i++) {
    const c = field[i];
    if (c === '<') depth++;
    else if (c === '>') depth--;
    else if (c === ':' && depth === 0) {
      return { name: field.slice(0, i).trim(), type: field.slice(i + 1).trim() };
    }
  }
  return { name: field.trim(), type: 'string' };
}

/** Build the child fields for a type_text, without a name (used for element types). */
function parseChildren(typeText: string): StructureField[] {
  const lower = typeText.trim().toLowerCase();
  if (lower.startsWith('struct<')) {
    return splitTopLevel(innerOf(typeText)).map((f) => {
      const { name, type } = splitNameType(f);
      return fieldFromType(name, type);
    });
  }
  if (lower.startsWith('array<')) {
    // array of scalars/structs — represent the element under a synthetic "item"
    return [fieldFromType('item', innerOf(typeText))];
  }
  return [];
}

/** Build a StructureField for a named column/field of the given type_text. */
export function fieldFromType(name: string, typeText: string): StructureField {
  const lower = typeText.trim().toLowerCase();
  if (lower.startsWith('array<')) {
    return { name, type: 'array', children: parseChildren(typeText) };
  }
  if (lower.startsWith('struct<')) {
    return { name, type: 'object', children: parseChildren(typeText) };
  }
  if (lower.startsWith('map<')) {
    // Represent map as an object; values not expanded (parity with original).
    return { name, type: 'object', children: [] };
  }
  return { name, type: scalarType(typeText) };
}
