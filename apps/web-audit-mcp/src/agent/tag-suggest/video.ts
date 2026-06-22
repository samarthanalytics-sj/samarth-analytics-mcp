// Detect embedded YouTube players from a page's <iframe> srcs, so we can suggest a
// GTM "YouTube Video" tag (the built-in youTubeVideo trigger only works for an
// embedded iframe player). PURE — no browser, no GTM.
//
// Only YouTube is handled: GTM ships a built-in YouTube Video trigger but has NO
// native trigger for Vimeo or HTML5 <video> (those need a custom-JS setup), so we
// don't suggest a directly-creatable tag for them.

/** True if an iframe src is an embedded YouTube PLAYER (youtube.com/embed/… or the
 *  privacy-enhanced youtube-nocookie.com/embed/…). A plain youtube.com/watch or a
 *  youtu.be share LINK is not an embedded player, so it does not qualify. */
export function isYouTubeEmbed(src: string): boolean {
  let host: string, path: string;
  try {
    const u = new URL(src, 'https://_');
    host = u.hostname.toLowerCase().replace(/^www\./, '');
    path = u.pathname;
  } catch {
    return false;
  }
  return (host === 'youtube.com' || host === 'youtube-nocookie.com') && /\/embed\//.test(path);
}

/** True if ANY of the page's iframe srcs is an embedded YouTube player. */
export function hasYouTubeEmbed(iframeSrcs: string[] | undefined): boolean {
  return (iframeSrcs ?? []).some(isYouTubeEmbed);
}
