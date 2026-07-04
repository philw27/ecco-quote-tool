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
    let rec = configs[configs.length - 1];
    for (const c of configs) {
      if (c.panelsCount <= 20) rec = c; else break;
    }

    const recommendedPanels = rec.panelsCount;
    const yearlyEnergyKwh = Math.round(rec.yearlyEnergyDcKwh || 0);
    const maxPanels = sp.maxArrayPanelsCount || null;
    const maxAreaM2 = sp.maxArrayAreaMeters2 ? Math.round(sp.maxArrayAreaMeters2) : null;
    const sunshineHours = sp.maxSunshineHoursPerYear ? Math.round(sp.maxSunshineHoursPerYear) : null;
    const carbonOffsetKgPerMwh = sp.carbonOffsetFactorKgPerMwh || null;

    // Panel geometry for drawing on the map.
    // sp.solarPanels[] is ordered best-first; take the first `recommendedPanels`.
    const panelW = sp.panelWidthMeters || 1.045;
    const panelH = sp.panelHeightMeters || 1.879;
    const allPanels = Array.isArray(sp.solarPanels) ? sp.solarPanels : [];
    const segs = Array.isArray(sp.roofSegmentStats) ? sp.roofSegmentStats : [];
    const panels = allPanels.slice(0, recommendedPanels).map(p => {
      // orientation: PORTRAIT or LANDSCAPE. azimuth comes from the roof segment it sits on.
      const seg = segs[p.segmentIndex || 0] || {};
      return {
        lat: p.center ? p.center.latitude : null,
        lng: p.center ? p.center.longitude : null,
        orientation: p.orientation || 'PORTRAIT',
        azimuth: seg.azimuthDegrees != null ? seg.azimuthDegrees : 0
      };
    }).filter(p => p.lat != null);

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
      recommendedPanels,
      recommendedKw: +((recommendedPanels * panelWatts) / 1000).toFixed(2),
      yearlyEnergyKwh,
      maxPanels,
      maxRoofAreaM2: maxAreaM2,
      sunshineHoursPerYear: sunshineHours,
      carbonOffsetKgPerMwh,
      panels
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error calling Solar API', detail: String(err).slice(0, 200) });
  }
}
