/** 轻量唯一 id（无第三方依赖，避免 nanoid ESM 打包问题） */
export function uid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(12));
    return Array.from(b).map(x => x.toString(36).padStart(2, '0')).join('').slice(0, 18);
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function sha1hex(input: string): Promise<string> {
  const c = globalThis.crypto;
  if (c && c.subtle) {
    const buf = await c.subtle.digest('SHA-1', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // 降级：非加密哈希（仅用于文件名，不涉及安全）
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    h1 = (h1 ^ input.charCodeAt(i)) * 16777619 >>> 0;
    h2 = (h2 + input.charCodeAt(i) * (i + 7)) >>> 0;
  }
  return (h1.toString(16) + h2.toString(16)).padStart(16, '0');
}
