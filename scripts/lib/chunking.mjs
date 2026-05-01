const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const DEFAULT_MAX_CHARS = 3200;
const DEFAULT_OVERLAP_CHARS = 400;

function normalizeText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function splitBlocks(markdown) {
  const blocks = [];
  const lines = normalizeText(markdown).split("\n");
  let headingStack = [];
  let buffer = [];
  let ordinal = 0;

  function flush() {
    const text = buffer.join("\n").trim();
    if (!text) {
      buffer = [];
      return;
    }

    blocks.push({
      ordinal: ordinal++,
      headingPath: headingStack.join(" > "),
      text
    });
    buffer = [];
  }

  for (const line of lines) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      const title = heading[2].trim();
      headingStack = headingStack.slice(0, level - 1);
      headingStack[level - 1] = title;
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    buffer.push(line);
  }

  flush();
  return blocks;
}

function splitOversizedText(text, maxChars, overlapChars) {
  if (text.length <= maxChars) {
    return [text];
  }

  const parts = [];
  let start = 0;

  while (start < text.length) {
    const hardEnd = Math.min(start + maxChars, text.length);
    let end = hardEnd;

    if (hardEnd < text.length) {
      const breakAt = text.lastIndexOf(". ", hardEnd);
      if (breakAt > start + Math.floor(maxChars * 0.55)) {
        end = breakAt + 1;
      }
    }

    parts.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(0, end - overlapChars);
  }

  return parts.filter(Boolean);
}

export function chunkMarkdown(markdown, options = {}) {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  const blocks = splitBlocks(markdown);
  const chunks = [];
  let current = null;

  function emit() {
    if (!current?.texts.length) return;
    const text = current.texts.join("\n\n").trim();
    chunks.push({
      chunkIndex: chunks.length,
      text,
      charCount: text.length,
      tokenCount: Math.ceil(text.length / 4),
      headingPath: current.headingPath || null,
      paragraphStart: current.paragraphStart,
      paragraphEnd: current.paragraphEnd,
      contentKind: current.contentKind
    });
    current = null;
  }

  for (const block of blocks) {
    const parts = splitOversizedText(block.text, maxChars, overlapChars);

    for (const part of parts) {
      const wouldOverflow = current && current.charCount + part.length + 2 > maxChars;
      const headingChanged = current && current.headingPath !== block.headingPath;

      if (wouldOverflow || headingChanged) {
        emit();
      }

      if (!current) {
        current = {
          headingPath: block.headingPath,
          paragraphStart: block.ordinal,
          paragraphEnd: block.ordinal,
          charCount: 0,
          contentKind: detectContentKind(block.headingPath, part),
          texts: []
        };
      }

      current.texts.push(part);
      current.charCount += part.length + 2;
      current.paragraphEnd = block.ordinal;
    }
  }

  emit();
  return chunks;
}

function detectContentKind(headingPath, text) {
  const haystack = `${headingPath ?? ""}\n${text.slice(0, 300)}`.toLowerCase();
  if (haystack.includes("| ---") || haystack.includes("<table")) return "table";
  if (haystack.includes("appendix") || haystack.includes("annex")) return "appendix";
  if (haystack.includes("references") || haystack.includes("bibliography")) return "reference";
  return "body";
}
