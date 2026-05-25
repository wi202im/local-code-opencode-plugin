const INTERNAL_DIFF_PATH_PREFIX = ".opencode/local-code/";

export function isInternalDiffPath(file) {
  return typeof file === "string" && (file === ".opencode/local-code" || file.startsWith(INTERNAL_DIFF_PATH_PREFIX));
}
