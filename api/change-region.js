// api/change-region.js — Change region after deploy
const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2';

const REGIONS = {
  'ams': { name: 'آمستردام', flag: '🇳🇱' },
  'sin': { name: 'سنگاپور', flag: '🇸🇬' },
  'sfo': { name: 'کالیفرنیا', flag: '🇺🇸' },
  'iad': { name: 'ویرجینیا', flag: '🇺🇸' },
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { railwayToken, serviceId, environmentId, region } = req.body || {};
  if (!railwayToken || !serviceId || !environmentId || !region) {
    return res.status(400).json({ error: 'All fields required' });
  }

  if (!REGIONS[region]) {
    return res.status(400).json({ error: 'Invalid region' });
  }

  try {
    // Update region
    await rq(`mutation($sid: String!, $eid: String!, $i: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $sid, environmentId: $eid, input: $i) }`, railwayToken, {
      sid: serviceId, eid: environmentId, i: { region }
    });

    // Redeploy to apply
    await rq(`mutation($eid: String!, $sid: String!) { serviceInstanceDeploy(environmentId: $eid, serviceId: $sid) }`, railwayToken, {
      eid: environmentId, sid: serviceId
    });

    return res.status(200).json({
      status: 'ok',
      region: region,
      regionName: REGIONS[region].name,
      flag: REGIONS[region].flag
    });

  } catch (err) {
    return res.status(200).json({ status: 'error', error: err.message });
  }
};

async function rq(query, token, variables = {}) {
  const r = await fetch(RAILWAY_GQL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ query, variables }) });
  const data = await r.json();
  if (data.errors) throw new Error(`Railway: ${data.errors[0].message}`);
  return data;
}
