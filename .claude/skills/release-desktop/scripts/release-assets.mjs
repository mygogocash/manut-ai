// Which release file an update address in latest.json names, for verify-release.mjs. tauri-action 0.6 wrote a
// download address (https://github.com/<repo>/releases/download/<tag>/<file>); from 1.0 it writes the GitHub API's
// address of the asset (https://api.github.com/repos/<repo>/releases/assets/<id>, its upload-version-json.ts at
// action-v1.0.0), which says no file name, so the name comes from the release's own asset list:
// `gh release view <tag> --repo mygogocash/manut-ai --json assets`, whose entries carry `apiUrl` and `name`.

export const REPO = "mygogocash/manut-ai";
const DOWNLOAD = `https://github.com/${REPO}/releases/download/`;
const ASSET = new RegExp(`^https://api\\.github\\.com/repos/${REPO.replace("/", "\\/")}/releases/assets/\\d+$`);

/**
 * The file name `url` points at in this repository's release, or an `error` saying why it points at none.
 * `assets` is the `assets` array of `gh release view --json assets`, or undefined when it was not given.
 */
export function updateFileName(url, assets) {
  if (url.startsWith(DOWNLOAD)) {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return name ? { name } : { error: "the address names no file" };
  }
  if (ASSET.test(url)) {
    if (!assets) return { error: "the address is an asset id: pass the release's asset list (see SKILL.md)" };
    const asset = assets.find((a) => a.apiUrl === url);
    return asset ? { name: asset.name } : { error: "no asset of the release has this address" };
  }
  return { error: "the address is not this repository's release" };
}
