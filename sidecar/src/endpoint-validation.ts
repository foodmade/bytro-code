function parseUrl(value: string, label: string): URL {
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!value || value !== value.trim() || hasControlCharacter) {
    throw new Error(`${label} contains invalid characters.`);
  }
  try {
    return new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
}

export function validateProviderBaseUrl(value: string): string {
  const parsed = parseUrl(value, "Provider base URL");
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
  ) {
    throw new Error("Provider base URL must use HTTP(S) and include a host.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "Provider base URL must not include credentials, query parameters, or fragments.",
    );
  }
  return value;
}

export function validateProxyUrl(value: string): string {
  const parsed = parseUrl(value, "Proxy URL");
  if (
    !["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol)
    || !parsed.hostname
  ) {
    throw new Error(
      "Proxy URL must use HTTP(S), SOCKS5, or SOCKS5H and include a host.",
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      "Proxy URL must not include query parameters or fragments.",
    );
  }
  return value;
}
