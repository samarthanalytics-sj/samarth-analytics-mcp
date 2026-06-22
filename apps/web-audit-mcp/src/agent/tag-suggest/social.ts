// Single source of truth for social networks — used to detect a social link (by
// host) AND to build the GTM {{Click URL}} trigger regex. The trigger uses a SHORT
// domain-alternation (e.g. "facebook\.com|linkedin\.com") matching how real
// containers do it (the corpus: short matchRegex like "facebook.com|instagram.com"),
// built from ONLY the networks the site actually links to. PURE.

export interface SocialNetwork {
  name: string;
  /** Registrable domains for this network (host match + the trigger regex). */
  domains: string[];
}

export const SOCIAL_NETWORKS: SocialNetwork[] = [
  { name: 'facebook', domains: ['facebook.com', 'fb.com', 'fb.me'] },
  { name: 'instagram', domains: ['instagram.com'] },
  { name: 'linkedin', domains: ['linkedin.com', 'lnkd.in'] },
  { name: 'youtube', domains: ['youtube.com', 'youtu.be'] },
  { name: 'twitter', domains: ['twitter.com', 'x.com'] },
  { name: 'tiktok', domains: ['tiktok.com'] },
  { name: 'pinterest', domains: ['pinterest.com'] },
  { name: 'snapchat', domains: ['snapchat.com'] },
  { name: 'reddit', domains: ['reddit.com'] },
  { name: 'threads', domains: ['threads.net'] },
  { name: 'tumblr', domains: ['tumblr.com'] },
  { name: 'whatsapp', domains: ['whatsapp.com', 'wa.me'] },
  { name: 'telegram', domains: ['telegram.org', 't.me'] },
  { name: 'discord', domains: ['discord.com', 'discord.gg'] },
  { name: 'vimeo', domains: ['vimeo.com'] },
  { name: 'twitch', domains: ['twitch.tv'] },
  { name: 'mastodon', domains: ['mastodon.social'] },
];

const escapeDots = (s: string): string => s.replace(/\./g, '\\.');

/** The social network this host belongs to (the host equals or is a subdomain of
 *  one of its registrable domains), or null. PRECISE — host-based. */
export function socialNetworkOf(host: string): string | null {
  const h = host.toLowerCase();
  for (const net of SOCIAL_NETWORKS) {
    for (const d of net.domains) {
      if (h === d || h.endsWith(`.${d}`)) return net.name;
    }
  }
  return null;
}

/** True if the host belongs to any social network. */
export function isSocialHost(host: string): boolean {
  return socialNetworkOf(host) !== null;
}

/** A SHORT {{Click URL}} matchRegex (corpus-style) for ONLY the given networks —
 *  their domains alternated, e.g. "facebook\.com|linkedin\.com". Empty/undefined →
 *  all networks. */
export function buildSocialUrlPattern(present?: Set<string>): string {
  const nets = present && present.size ? SOCIAL_NETWORKS.filter((n) => present.has(n.name)) : SOCIAL_NETWORKS;
  return nets.flatMap((n) => n.domains).map(escapeDots).join('|');
}
