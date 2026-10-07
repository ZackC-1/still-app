// The approved V3 control inventory. Each site's first row is its free core control (starts On); every Pro control starts Off.
// The section header switch is the service switch; TikTok has only that one whole-site switch.
// ids are engineering-owned; sidebar_ads keeps its legacy id. Hosts filter by real capability, not by this list.
export const SiteInventory = {
  youtube: { name: 'YouTube', title: 'YouTube Blocker', service: 'Still on YouTube', controls: [
    { id: 'yt_shorts', label: 'Shorts', free: true, defaultOn: true },
    { id: 'yt_related', label: 'Related videos' },
    { id: 'yt_endscreen', label: 'End-of-video suggestions' },
    { id: 'yt_autoplay', label: 'Autoplay prevention' },
    { id: 'yt_comments', label: 'Comments' },
    { id: 'yt_livechat', label: 'Live chat' },
  ] },
  instagram: { name: 'Instagram', title: 'Instagram Blocker', service: 'Still on Instagram', controls: [
    { id: 'ig_reels', label: 'Reels', free: true, defaultOn: true },
    { id: 'ig_stories', label: 'Stories and Highlights' },
    { id: 'ig_explore', label: 'Explore recommendations', sub: 'Search stays.' },
    { id: 'ig_suggested', label: 'Suggested accounts' },
    { id: 'ig_threads', label: 'Threads links' },
  ] },
  facebook: { name: 'Facebook', title: 'Facebook Blocker', service: 'Still on Facebook', controls: [
    { id: 'fb_reels', label: 'Reels', free: true, defaultOn: true },
    { id: 'fb_stories', label: 'Facebook Stories' },
    { id: 'fb_videos', label: 'Videos and Watch' },
    { id: 'sidebar_ads', label: 'Desktop sidebar ads' },
  ] },
  tiktok: { name: 'TikTok', title: 'TikTok Blocker', service: 'TikTok website', controls: [] },
};

export const SiteOrder = ['youtube', 'instagram', 'facebook', 'tiktok'];

export function ProControlList(hostFilter) {
  const out = [];
  SiteOrder.forEach(k => SiteInventory[k].controls.forEach(c => { if (c.free) return; if (!hostFilter || hostFilter(c)) out.push({ site: SiteInventory[k].name, label: c.label, id: c.id }); }));
  return out;
}
