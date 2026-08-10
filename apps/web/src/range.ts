export type ParsedByteRange =
  { kind: 'none' } | { kind: 'invalid' } | { kind: 'range'; start: number; end: number };

export const parseByteRange = (header: string | undefined, size: number): ParsedByteRange => {
  if (header === undefined) return { kind: 'none' };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return { kind: 'none' };

  const first = match[1] ?? '';
  const last = match[2] ?? '';
  if (size <= 0 || (first === '' && last === '')) return { kind: 'invalid' };

  if (first === '') {
    const suffixLength = Number(last);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'invalid' };

    return {
      kind: 'range',
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(first);
  const requestedEnd = last === '' ? size - 1 : Number(last);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) {
    return { kind: 'invalid' };
  }

  const end = Math.min(requestedEnd, size - 1);
  if (start > end || start >= size) return { kind: 'invalid' };

  return { kind: 'range', start, end };
};
