const EARTH_RADIUS = 6378137;

export function latLngToLocalXYZ(lat, lng, origin) {
  const dLat = ((lat - origin.lat) * Math.PI) / 180;
  const dLng = ((lng - origin.lng) * Math.PI) / 180;
  const meanLat = (((lat + origin.lat) * 0.5) * Math.PI) / 180;

  const x = dLng * EARTH_RADIUS * Math.cos(meanLat);
  const z = dLat * EARTH_RADIUS;
  const y = 0;

  return { x, y, z };
}
