// Single source of truth for social networks — used BOTH to detect a social link
// (by host) AND to build the GTM {{Click URL}} trigger regex, so the two can never
// diverge. The trigger is built from ONLY the networks actually found on the site
// (buildSocialUrlPattern(present)), so it doesn't fire on networks the site
// doesn't link to. PURE — no browser, no GTM.

export interface SocialNetwork {
  name: string;
  /** Brand labels matched as the registrable host label (facebook.com, m.facebook.co.uk). */
  longs: string[];
  /** Whole short/share hosts (fb.me, lnkd.in, youtu.be). RE2 source, dots escaped. */
  shorts: string[];
}

export const SOCIAL_NETWORKS: SocialNetwork[] = [
  { name: 'facebook', longs: ['facebook'], shorts: ['fb\\.(com|me)', 'm\\.me'] },
  { name: 'instagram', longs: ['instagram'], shorts: ['instagr\\.am'] },
  { name: 'linkedin', longs: ['linkedin'], shorts: ['lnkd\\.in'] },
  { name: 'youtube', longs: ['youtube'], shorts: ['youtu\\.be'] },
  { name: 'twitter', longs: ['twitter'], shorts: ['x\\.com', 't\\.co'] },
  { name: 'tiktok', longs: ['tiktok'], shorts: [] },
  { name: 'pinterest', longs: ['pinterest'], shorts: ['pin\\.it'] },
  { name: 'snapchat', longs: ['snapchat'], shorts: [] },
  { name: 'reddit', longs: ['reddit'], shorts: [] },
  { name: 'threads', longs: ['threads'], shorts: [] },
  { name: 'tumblr', longs: ['tumblr'], shorts: [] },
  { name: 'whatsapp', longs: ['whatsapp'], shorts: ['wa\\.me'] },
  { name: 'telegram', longs: ['telegram'], shorts: ['t\\.me'] },
  { name: 'discord', longs: ['discord'], shorts: [] },
  { name: 'vimeo', longs: ['vimeo'], shorts: [] },
  { name: 'twitch', longs: ['twitch'], shorts: [] },
  { name: 'mastodon', longs: ['mastodon'], shorts: [] },
];

const longRe = (net: SocialNetwork): RegExp =>
  new RegExp(`(?:^|\\.)(${net.longs.join('|')})\\.[a-z]{2,}(?:\\.[a-z]{2,})?$`, 'i');
const shortRe = (net: SocialNetwork): RegExp | null =>
  net.shorts.length ? new RegExp(`^(www\\.)?(${net.shorts.join('|')})$`, 'i') : null;

/** The social network this host belongs to (registrable-label match), or null. */
export function socialNetworkOf(host: string): string | null {
  for (const net of SOCIAL_NETWORKS) {
    if (net.longs.length && longRe(net).test(host)) return net.name;
    const sr = shortRe(net);
    if (sr && sr.test(host)) return net.name;
  }
  return null;
}

/** True if the host is any social network (registrable-label / whole-short-host). */
export function isSocialHost(host: string): boolean {
  return socialNetworkOf(host) !== null;
}

/** Build the {{Click URL}} matchRegex for the social trigger from ONLY the given
 *  networks (by name). Host-anchored + (?i). Empty/undefined → all networks. */
export function buildSocialUrlPattern(present?: Set<string>): string {
  const nets = present && present.size ? SOCIAL_NETWORKS.filter((n) => present.has(n.name)) : SOCIAL_NETWORKS;
  const longs = nets.flatMap((n) => n.longs);
  const shorts = nets.flatMap((n) => n.shorts);
  const parts: string[] = [];
  if (longs.length) parts.push(`://([a-z0-9-]+\\.)*(${longs.join('|')})\\.[a-z]{2,}(\\.[a-z]{2,})?([/:?#]|$)`);
  if (shorts.length) parts.push(`://(www\\.)?(${shorts.join('|')})([/:?#]|$)`);
  return `(?i)${parts.join('|')}`;
}
