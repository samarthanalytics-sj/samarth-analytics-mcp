// Brand icon for a GTM tag in the container audit. The detection + SVG live in shared/tag-brand.ts
// (single source of truth — the PDF export renders the exact same glyphs); this is just the thin
// React wrapper. The SVG is our own static, escaped markup — never user content — so injecting it
// via innerHTML is safe.

import { detectTagBrand, tagBrandSvg } from '../../shared/tag-brand';

export function TagTypeIcon({ type, name, size = 15 }: { type?: string; name?: string; size?: number }): JSX.Element {
  return (
    <span
      style={{ display: 'inline-block', width: size, height: size, flexShrink: 0, lineHeight: 0 }}
      dangerouslySetInnerHTML={{ __html: tagBrandSvg(detectTagBrand(type, name), size) }}
    />
  );
}
