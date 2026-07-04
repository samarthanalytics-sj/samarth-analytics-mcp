// Brand icons for GTM tag types in the container audit — mirrors how GTM's own UI shows a
// recognisable icon per tag. Pure inline SVG (no remote favicon fetches: works offline and under
// any CSP). Detection: the GTM `type` code first (gaawe, googtag, awct, html, …); for Custom HTML
// and gallery templates (cvt_*), where the type says nothing about the vendor, the tag NAME.

export type TagBrand =
  | 'ga4'
  | 'googtag'
  | 'gads'
  | 'floodlight'
  | 'msads'
  | 'linkedin'
  | 'hotjar'
  | 'meta'
  | 'pinterest'
  | 'tiktok'
  | 'snap'
  | 'amplitude'
  | 'consent'
  | 'clarity'
  | 'x'
  | 'html'
  | 'img'
  | 'tag';

const BY_TYPE: Record<string, TagBrand> = {
  gaawe: 'ga4',
  gaawc: 'ga4',
  ua: 'ga4',
  googtag: 'googtag',
  awct: 'gads',
  sp: 'gads',
  gclidw: 'gads',
  flc: 'floodlight',
  fls: 'floodlight',
  baut: 'msads',
  bzi: 'linkedin',
  hjtc: 'hotjar',
  img: 'img',
};

/** Pick the brand for a tag from its GTM type code, falling back to vendor hints in the tag /
 *  template name (Custom HTML and cvt_* gallery templates carry the vendor only in the name). */
export function detectTagBrand(type?: string, name?: string): TagBrand {
  const t = (type ?? '').toLowerCase();
  if (BY_TYPE[t]) return BY_TYPE[t];
  const n = `${(name ?? '').toLowerCase()} ${t}`;
  if (/pinterest|pntrst/.test(n)) return 'pinterest';
  if (/facebook|fb pixel|fbevents|meta pixel|meta capi|\bmeta\b/.test(n)) return 'meta';
  if (/tiktok/.test(n)) return 'tiktok';
  if (/linkedin/.test(n)) return 'linkedin';
  if (/snap(chat|\s*pixel)/.test(n)) return 'snap';
  if (/amplitude/.test(n)) return 'amplitude';
  if (/cookieyes|cookiebot|onetrust|usercentrics|consentmanager|iubenda|\bcmp\b|consent/.test(n)) return 'consent';
  if (/hotjar/.test(n)) return 'hotjar';
  if (/clarity/.test(n)) return 'clarity';
  if (/twitter|\bx pixel\b/.test(n)) return 'x';
  if (/google ads|adwords/.test(n)) return 'gads';
  if (/floodlight/.test(n)) return 'floodlight';
  if (/ga4|google analytics/.test(n)) return 'ga4';
  if (t === 'html') return 'html';
  return 'tag';
}

const letterIcon = (bg: string, letter: string, fg = '#fff', rx = 3.5): JSX.Element => (
  <>
    <rect x="1" y="1" width="14" height="14" rx={rx} fill={bg} />
    <text x="8" y="11.6" textAnchor="middle" fontSize="9.5" fontWeight={700} fontFamily="Arial, Helvetica, sans-serif" fill={fg}>
      {letter}
    </text>
  </>
);

/** The 16x16 glyph for one brand. Simplified, flat marks — enough to recognise the vendor at a
 *  glance (the same job GTM's template icons do), without shipping binary assets. */
function glyph(brand: TagBrand): JSX.Element {
  switch (brand) {
    case 'ga4': // the GA "growth" mark: tall bar, mid bar, dot — GA orange
      return (
        <>
          <rect x="10.6" y="1.6" width="3.8" height="12.8" rx="1.9" fill="#F9AB00" />
          <rect x="6.1" y="6.4" width="3.8" height="8" rx="1.9" fill="#E37400" />
          <circle cx="3.5" cy="12.5" r="1.9" fill="#E37400" />
        </>
      );
    case 'googtag': // Google tag: blue rotated-square "price tag" with a white dot
      return (
        <>
          <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="2" fill="#4285F4" transform="rotate(45 8 8)" />
          <circle cx="8" cy="8" r="1.7" fill="#fff" />
        </>
      );
    case 'gads': // Google Ads: slanted blue + yellow bars, green dot
      return (
        <>
          <rect x="6.2" y="1.2" width="3.6" height="11" rx="1.8" fill="#FBBC04" transform="rotate(-30 8 8)" />
          <rect x="6.2" y="3.8" width="3.6" height="11" rx="1.8" fill="#4285F4" transform="rotate(30 8 8)" />
          <circle cx="3.3" cy="12.6" r="2.3" fill="#34A853" />
        </>
      );
    case 'floodlight': // Floodlight: green target
      return (
        <>
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="#0F9D58" strokeWidth="2" />
          <circle cx="8" cy="8" r="2.4" fill="#0F9D58" />
        </>
      );
    case 'msads': // Microsoft: the four squares
      return (
        <>
          <rect x="1.5" y="1.5" width="6" height="6" fill="#F25022" />
          <rect x="8.5" y="1.5" width="6" height="6" fill="#7FBA00" />
          <rect x="1.5" y="8.5" width="6" height="6" fill="#00A4EF" />
          <rect x="8.5" y="8.5" width="6" height="6" fill="#FFB900" />
        </>
      );
    case 'linkedin':
      return letterIcon('#0A66C2', 'in', '#fff', 3);
    case 'hotjar':
      return letterIcon('#FF3C00', 'h');
    case 'meta': // Facebook/Meta pixel: the familiar blue f
      return (
        <>
          <circle cx="8" cy="8" r="7" fill="#0866FF" />
          <text x="8.6" y="12.4" textAnchor="middle" fontSize="10.5" fontWeight={700} fontFamily="Arial, Helvetica, sans-serif" fill="#fff">
            f
          </text>
        </>
      );
    case 'pinterest':
      return (
        <>
          <circle cx="8" cy="8" r="7" fill="#E60023" />
          <text x="8" y="12" textAnchor="middle" fontSize="10" fontWeight={700} fontFamily="Arial, Helvetica, sans-serif" fill="#fff">
            P
          </text>
        </>
      );
    case 'tiktok': // black square, white note
      return (
        <>
          <rect x="1" y="1" width="14" height="14" rx="3.5" fill="#010101" />
          <text x="8" y="12" textAnchor="middle" fontSize="10" fontWeight={700} fontFamily="Arial, Helvetica, sans-serif" fill="#fff">
            ♪
          </text>
        </>
      );
    case 'snap': // Snapchat: yellow square, white ghost silhouette
      return (
        <>
          <rect x="1" y="1" width="14" height="14" rx="3.5" fill="#FFFC00" />
          <path
            d="M8 3.2c-1.9 0-3.1 1.4-3.1 3.2v1.5c-.4.9-1.2 1.3-1.2 1.7 0 .5 1 .5 1.4.9.2.3 0 1 .4 1.2.4.2.9-.2 1.5-.1.5.2.9.8 1.9.8s1.4-.6 1.9-.8c.6-.1 1.1.3 1.5.1.4-.2.2-.9.4-1.2.4-.4 1.4-.4 1.4-.9 0-.4-.8-.8-1.2-1.7V6.4c0-1.8-1.2-3.2-3.1-3.2z"
            fill="#fff"
            stroke="#010101"
            strokeWidth="0.5"
          />
        </>
      );
    case 'amplitude': // blue circle, white pulse line
      return (
        <>
          <circle cx="8" cy="8" r="7" fill="#1E61F0" />
          <polyline points="3.5,8.5 6,8.5 7.2,4.5 8.8,11.5 10,8.5 12.5,8.5" fill="none" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case 'consent': // CMPs (CookieYes, Cookiebot, OneTrust, …): a cookie
      return (
        <>
          <circle cx="8" cy="8" r="6.8" fill="#C98B4B" />
          <circle cx="5.6" cy="6.2" r="1.1" fill="#7A4E22" />
          <circle cx="9.9" cy="5.4" r="1" fill="#7A4E22" />
          <circle cx="7.4" cy="10.3" r="1.2" fill="#7A4E22" />
          <circle cx="11" cy="9.4" r="0.9" fill="#7A4E22" />
        </>
      );
    case 'clarity':
      return letterIcon('#1F6BF1', 'C');
    case 'x':
      return letterIcon('#000000', 'X');
    case 'img': // custom image pixel: picture glyph
      return (
        <>
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="#5F6368" strokeWidth="1.5" />
          <circle cx="5.4" cy="6.4" r="1.3" fill="#5F6368" />
          <path d="M3 12l3.4-3.4 2.2 2.2 2.6-3 2.8 4.2z" fill="#5F6368" />
        </>
      );
    case 'html': // custom HTML: the </> code glyph
      return (
        <>
          <path d="M5.5 4.5 2 8l3.5 3.5" fill="none" stroke="#5F6368" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M10.5 4.5 14 8l-3.5 3.5" fill="none" stroke="#5F6368" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 3.2 7 12.8" fill="none" stroke="#5F6368" strokeWidth="1.5" strokeLinecap="round" />
        </>
      );
    default: // generic tag: neutral price-tag outline
      return (
        <>
          <path d="M8.6 2H13a1 1 0 0 1 1 1v4.4a1 1 0 0 1-.3.7l-6 6a1 1 0 0 1-1.4 0L2.9 10.7a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1-.3 0z" fill="none" stroke="#8A8F98" strokeWidth="1.5" strokeLinejoin="round" />
          <circle cx="11.2" cy="4.8" r="1.1" fill="#8A8F98" />
        </>
      );
  }
}

/** Inline brand icon for a GTM tag, sized to sit beside 13px text. */
export function TagTypeIcon({ type, name, size = 15 }: { type?: string; name?: string; size?: number }): JSX.Element {
  const brand = detectTagBrand(type, name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ flexShrink: 0, verticalAlign: '-2px', display: 'inline-block' }}
    >
      {glyph(brand)}
    </svg>
  );
}
