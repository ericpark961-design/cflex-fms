// Device id normalisation.
//
// The backend is inconsistent on purpose (backend/routes/fms.routes.js):
//   /v1/fms/floor, /v1/fms/assets   → id = ups_devices.id            (number, e.g. 41)
//   /v1/fms/alerts                  → device_id = 'ups-' || d.id     (string, e.g. "ups-41")
//   /v1/fms/assets/:id              → parseInt(:id)                  (number)
// So an alert's device_id can never be compared to, or fetched as, an asset id
// without stripping the prefix first. The mock server happens to use 'ups-N' for
// both, which hides this — always normalise before comparing or fetching.
export const devId = (v) => String(v ?? '').replace(/^ups-/i, '');
export const sameDev = (a, b) => devId(a) !== '' && devId(a) === devId(b);
