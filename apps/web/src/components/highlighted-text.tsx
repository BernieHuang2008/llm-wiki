// Kept in sync with HIGHLIGHT_START/HIGHLIGHT_END in
// packages/core/src/search-meili.ts. Defined locally so client components do
// not pull the Node-only core package into the browser bundle.
const HIGHLIGHT_START = "\uE000";
const HIGHLIGHT_END = "\uE001";

type Segment = { text: string; match: boolean };

function splitHighlights(text: string): Segment[] {
  const segments: Segment[] = [];
  let rest = text;
  let match = false;
  for (;;) {
    const marker = match ? HIGHLIGHT_END : HIGHLIGHT_START;
    const idx = rest.indexOf(marker);
    if (idx === -1) {
      if (rest.length > 0) segments.push({ text: rest, match });
      break;
    }
    if (idx > 0) segments.push({ text: rest.slice(0, idx), match });
    rest = rest.slice(idx + marker.length);
    match = !match;
  }
  return segments;
}

/** Strip the sentinels for callers that need plain text (tooltips, aria). */
export function stripHighlightMarkers(text: string): string {
  return text.split(HIGHLIGHT_START).join("").split(HIGHLIGHT_END).join("");
}

export function HighlightedText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <span className={className}>
      {splitHighlights(text).map((segment, index) =>
        segment.match ? (
          <mark
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            className="bg-transparent font-semibold text-red-600 dark:text-red-400"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </span>
  );
}
