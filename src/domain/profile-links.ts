export type ProfileLinkProvider = 'github' | 'linkedin';

export function isAllowedProfileUrl(value: string, provider: ProfileLinkProvider): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;

    const hostname = url.hostname.toLowerCase();
    if (provider === 'github') {
      return hostname === 'github.com' || hostname === 'www.github.com';
    }

    return hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com');
  } catch {
    return false;
  }
}
