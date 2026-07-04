// /api/solar.js
// Vercel serverless function — calls Google Solar API (Building Insights) server-side.
// The SOLAR_API_KEY is read from Vercel environment variables and never exposed to the browser.
//
// Usage from the browser:  fetch(`/api/solar?lat=53.41&lng=-2.99`)
// Returns a normalised JSON summary the front-end can drop straight into the visualiser.

export default async function handler(req, res) {
  // Basic CORS / method guard
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const key = process.env.SOLAR_API_KEY;
  if (!key) {
    res.status(500).json({ ok: false, error: 'Solar API key not configured on server' });
    return;
  }

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    res.status(400).json({ ok: false, error: 'Missing or invalid lat/lng' });
    return;
  }

  // Ask for the best imagery we can get, but allow lower quality so more roofs return data.
  const url = `https://solar.googleapis.com/v1/buildingInsights:findClosest`
    + `?location.latitude=${lat}`
    + `&location.longitude=${lng}`
    + `&requiredQuality=LOW`
    + `&key=${key}`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      // 404 => no building/solar data at this location. Handle gracefully.
      if (r.status === 404) {
        res.status(200).json({ ok: true, covered: false, reason: 'No solar data for this location' });
        return;
      }
      const text = await r.text();
      res.status(502).json({ ok: false, error: 'Solar API error', status: r.status, detail: text.slice(0, 300) });
      return;
    }

    const data = await r.json();
    const sp = data.solarPotential;

    // If the roof was found but no panels could be placed, treat as "needs manual assessment".
    if (!sp || !Array.isArray(sp.solarPanelConfigs) || sp.solarPanelConfigs.length === 0) {
      res.status(200).json({
        ok: true,
        covered: true,
        panelsPlaceable: false,
        reason: 'Roof found but no standard panel layout available — manual assessment needed',
        imageryQuality: data.imageryQuality || null
      });
      return;
    }

    // Pick a sensible "recommended" config: the one closest to covering a typical home.
    // Solar API returns configs of increasing panel counts; we choose a mid/large sensible default.
    const configs = sp.solarPanelConfigs;
    const panelWatts = sp.panelCapacityWatts || 400;   // Google default assumption
    // Recommend the largest config that still fits, capped to a reasonable domestic size (~20 panels).
    // Roof-driven fit: use Google's LARGEST config = the real number of panels
    // that physically fit on the usable, sun-worthy roof segments.
    const rec = configs[configs.length - 1];
    const googleFitPanels = rec.panelsCount; // Google's own layout count (for reference)

    // --- MCS-style area calc: usable slope area ÷ panel area ---
    // LONGi Hi-MO 6 residential module: 1.722m x 1.133m = 1.951 m²
    const PANEL_AREA_M2 = 1.722 * 1.133;   // ≈ 1.951
    const USABLE_COVERAGE = 0.75;          // 75% usable after setbacks/exclusions (clean pitched roof)
    const segsRaw = Array.isArray(sp.roofSegmentStats) ? sp.roofSegmentStats : [];
    // sum panels that fit across roof segments (uses sloped areaMeters2, already pitch-correct)
    let areaFitPanels = 0;
    segsRaw.forEach(s => {
      const area = (s.stats && s.stats.areaMeters2 != null) ? s.stats.areaMeters2
                 : (s.areaMeters2 != null ? s.areaMeters2 : 0);
      const usable = area * USABLE_COVERAGE;
      areaFitPanels += Math.floor(usable / PANEL_AREA_M2);
    });
    // Roof fit = our area calc, but never more than Google actually laid out (sanity ceiling)
    const roofFitPanels = Math.min(areaFitPanels || googleFitPanels, googleFitPanels || areaFitPanels);
    // Sensible domestic default (BOXT-style right-sizing), capped by what the roof fits.
    const DEFAULT_SYSTEM = 10;                 // standard ~4kW starting system
    const recommendedPanels = Math.min(DEFAULT_SYSTEM, roofFitPanels);
    // Find the Google config closest to our recommended panel count for accurate production.
    let recConfig = configs[0];
    for (const c of configs) {
      if (c.panelsCount <= recommendedPanels) recConfig = c; else break;
    }
    const yearlyEnergyKwh = Math.round(recConfig.yearlyEnergyDcKwh || rec.yearlyEnergyDcKwh || 0);
    const maxPanels = sp.maxArrayPanelsCount || null;
    const maxAreaM2 = sp.maxArrayAreaMeters2 ? Math.round(sp.maxArrayAreaMeters2) : null;
    const sunshineHours = sp.maxSunshineHoursPerYear ? Math.round(sp.maxSunshineHoursPerYear) : null;
    const carbonOffsetKgPerMwh = sp.carbonOffsetFactorKgPerMwh || null;

    // Panel geometry for drawing on the map.
    const panelW = sp.panelWidthMeters || 1.045;
    const panelH = sp.panelHeightMeters || 1.879;
    const allPanels = Array.isArray(sp.solarPanels) ? sp.solarPanels : [];
    const segs = Array.isArray(sp.roofSegmentStats) ? sp.roofSegmentStats : [];
    const panels = allPanels.slice(0, recommendedPanels).map(p => {
      // segmentIndex can be 0 (valid) — coerce carefully, don't treat 0 as missing
      let si = (p.segmentIndex != null) ? p.segmentIndex
             : (p._segment_index != null) ? p._segment_index : 0;
      const seg = segs[si] || {};
      return {
        lat: p.center ? p.center.latitude : null,
        lng: p.center ? p.center.longitude : null,
        orientation: p.orientation || 'PORTRAIT',
        segmentIndex: si,
        azimuth: (seg.azimuthDegrees != null) ? seg.azimuthDegrees : 0,
        pitch: (seg.pitchDegrees != null) ? seg.pitchDegrees : 0
      };
    }).filter(p => p.lat != null);

    // Also return the segment azimuths so the client can group/verify
    const segments = segs.map((s,i)=>({
      index:i,
      azimuth: s.azimuthDegrees != null ? s.azimuthDegrees : 0,
      pitch: s.pitchDegrees != null ? s.pitchDegrees : 0
    }));

    res.status(200).json({
      ok: true,
      covered: true,
      panelsPlaceable: true,
      imageryQuality: data.imageryQuality || null,
      imageryDate: data.imageryDate || null,
      center: data.center || { latitude: lat, longitude: lng },
      panelWatts,
      panelWidthMeters: panelW,
      panelHeightMeters: panelH,
      roofFitPanels,
      areaFitPanels,
      googleFitPanels,
      recommendedPanels,
      recommendedKw: +((recommendedPanels * panelWatts) / 1000).toFixed(2),
      yearlyEnergyKwh,
      maxPanels,
      maxRoofAreaM2: maxAreaM2,
      sunshineHoursPerYear: sunshineHours,
      carbonOffsetKgPerMwh,
      panels,
      segments
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error calling Solar API', detail: String(err).slice(0, 200) });
  }
}
