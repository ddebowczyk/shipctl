import type { ReactNode } from "react";

interface SearchSegment {
  text: string;
  match: boolean;
}

function getSearchSegments(text: string, query: string): SearchSegment[] {
  if (!text) return [{ text: "", match: false }];

  const needle = query.trim().toLowerCase();
  if (!needle) return [{ text, match: false }];

  const haystack = text.toLowerCase();
  const segments: SearchSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIdx = haystack.indexOf(needle, cursor);
    if (matchIdx === -1) {
      segments.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (matchIdx > cursor) {
      segments.push({ text: text.slice(cursor, matchIdx), match: false });
    }
    segments.push({
      text: text.slice(matchIdx, matchIdx + needle.length),
      match: true,
    });
    cursor = matchIdx + needle.length;
  }

  return segments.length > 0 ? segments : [{ text, match: false }];
}

export function renderSearchHighlight(text: string, query: string): ReactNode {
  const segments = getSearchSegments(text, query);
  return segments.map((segment, idx) =>
    segment.match ? (
      <mark key={idx} className="search-highlight">
        {segment.text}
      </mark>
    ) : (
      <span key={idx}>{segment.text}</span>
    ),
  );
}
