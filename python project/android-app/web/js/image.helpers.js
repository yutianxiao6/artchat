(function () {
  window.ImageCanvasHelpers = window.ImageCanvasHelpers || {};

  window.ImageCanvasHelpers.resolveCanvasSize = function resolveCanvasSize(resolution, ratio) {
    const longSideMap = { "1K": 1024, "2K": 2048, "4K": 3840 };
    const longSide = longSideMap[String(resolution || "1K")] || 1024;
    const parts = String(ratio || "1:1").split(":").map((v) => Math.max(1, Number(v || 1)));
    const rw = parts[0] || 1, rh = parts[1] || 1;
    const landscape = rw >= rh;
    const ratioValue = rw / rh;
    let width, height;
    if (landscape) { width = longSide; height = Math.round(longSide / ratioValue); }
    else { height = longSide; width = Math.round(longSide * ratioValue); }
    width = Math.max(512, Math.round(width / 64) * 64);
    height = Math.max(512, Math.round(height / 64) * 64);
    return { width, height };
  };

window.ImageCanvasHelpers.extractBase64 = function extractBase64(value) {
  if (!value) return "";
  if (String(value).startsWith("data:image") && String(value).includes(",")) return String(value).split(",", 2)[1];
  return "";
};
window.ImageCanvasHelpers.normalizeImageResult = function normalizeImageResult(item) {
  if (!item) return "";
  if (item.url) return item.url;
  const raw = String(item.b64_json || item.base64 || "").trim();
  if (!raw) return "";
  if (raw.startsWith("data:image")) return raw;
  return `data:image/png;base64,${raw}`;
};
window.ImageCanvasHelpers.guessMimeTypeFromImageUrl = function guessMimeTypeFromImageUrl(url) {
  const value = String(url || "").toLowerCase();
  if (value.includes(".webp")) return "image/webp";
  if (value.includes(".jpg") || value.includes(".jpeg")) return "image/jpeg";
  if (value.includes(".gif")) return "image/gif";
  return "image/png";
};
})();

