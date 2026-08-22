// Solar position from the NOAA General Solar Position Calculations (GML):
// fractional year -> equation of time + declination Fourier series -> true
// solar time -> hour angle -> zenith/azimuth. Accuracy ~0.2 deg, which is
// far tighter than anything the sky rendering needs. No dependencies.

const RAD = Math.PI / 180;

// date: JS Date (UTC-based), lat/lon in degrees (lon east-positive).
// Returns { azimuthDeg (0=N, 90=E), elevationDeg }.
export function sunPosition(date, lat, lon) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const doy = (date.getTime() - start) / 86400000; // fractional day of year, 0-based
  const hourUTC = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const g = (2 * Math.PI / 365) * (doy + (hourUTC - 12) / 24); // fractional year, rad

  // equation of time (minutes) and solar declination (radians)
  const eqtime = 229.18 * (0.000075
    + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918
    - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);

  // true solar time (minutes), hour angle (radians; 0 at solar noon, +afternoon)
  const tst = ((hourUTC * 60 + eqtime + 4 * lon) % 1440 + 1440) % 1440;
  const ha = (tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180) * RAD;

  const phi = lat * RAD;
  const cosZen = Math.sin(phi) * Math.sin(decl)
    + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZen)));
  const elevationDeg = 90 - zen / RAD;

  // azimuth measured clockwise from north
  const sinZen = Math.sin(zen);
  let az;
  if (sinZen < 1e-6) {
    az = 0; // sun at zenith/nadir: azimuth undefined, pick north
  } else {
    const cosAz = (Math.sin(phi) * cosZen - Math.sin(decl)) / (Math.cos(phi) * sinZen);
    az = Math.acos(Math.min(1, Math.max(-1, cosAz))); // 0 = north, via south
    az = ha > 0 ? Math.PI + az : Math.PI - az;        // afternoon sun is west of S
  }
  return { azimuthDeg: ((az / RAD) % 360 + 360) % 360, elevationDeg };
}

// Unit vector toward the sun in local east/north/up coordinates.
export function sunVectorENU(date, lat, lon) {
  const { azimuthDeg, elevationDeg } = sunPosition(date, lat, lon);
  const az = azimuthDeg * RAD, el = elevationDeg * RAD;
  return [
    Math.cos(el) * Math.sin(az), // east
    Math.cos(el) * Math.cos(az), // north
    Math.sin(el),                // up
  ];
}
