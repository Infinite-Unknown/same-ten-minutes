// Elevation from Terrain Tiles (Mapzen "terrarium" PNG encoding):
// metres = R * 256 + G + B / 256 - 32768

export const ELEVATION_ZOOM = 15;
export const terrariumUrl = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export function lonToTileX(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z;
}
export function latToTileY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

/** Tile coordinates covering a bbox [s, w, n, e]. */
export function tilesForBbox(bbox: [number, number, number, number], z = ELEVATION_ZOOM) {
  const [s, w, n, e] = bbox;
  const x0 = Math.floor(lonToTileX(w, z));
  const x1 = Math.floor(lonToTileX(e, z));
  const y0 = Math.floor(latToTileY(n, z));
  const y1 = Math.floor(latToTileY(s, z));
  const out: { x: number; y: number }[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ x, y });
  return out;
}

/** RGBA pixels of 256x256 tiles, keyed "x/y". */
export type TilePixels = Map<string, Uint8Array | Uint8ClampedArray>;

function decode(px: Uint8Array | Uint8ClampedArray, i: number) {
  return px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768;
}

/** Bilinear elevation sampler over a set of decoded tiles. Returns NaN outside them. */
export function makeSampler(tiles: TilePixels, z = ELEVATION_ZOOM) {
  const at = (gx: number, gy: number) => {
    const tx = Math.floor(gx / 256);
    const ty = Math.floor(gy / 256);
    const px = tiles.get(`${tx}/${ty}`);
    if (!px) return NaN;
    const lx = gx - tx * 256;
    const ly = gy - ty * 256;
    return decode(px, (ly * 256 + lx) * 4);
  };
  return (lat: number, lon: number) => {
    const fx = lonToTileX(lon, z) * 256 - 0.5;
    const fy = latToTileY(lat, z) * 256 - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const dx = fx - x0;
    const dy = fy - y0;
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    if ([a, b, c, d].some(Number.isNaN)) return [a, b, c, d].find((v) => !Number.isNaN(v)) ?? NaN;
    return a * (1 - dx) * (1 - dy) + b * dx * (1 - dy) + c * (1 - dx) * dy + d * dx * dy;
  };
}
