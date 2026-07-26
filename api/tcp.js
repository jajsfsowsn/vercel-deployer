// api/tcp.js — TCP Proxy test + recreate

const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2';

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const { action, railwayToken, serviceId, environmentId, host, port } = req.body || {};
    if (!railwayToken) return res.status(400).json({ error: 'Token required' });

    try {
        if (action === 'test') {
            if (!host) return res.status(400).json({ error: 'host required' });
            try {
                const ctrl = new AbortController();
                const tid = setTimeout(() => ctrl.abort(), 5000);
                await fetch(`https://${host}`, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
                clearTimeout(tid);
                return res.json({ status: 'ok' });
            } catch (e) {
                try {
                    await fetch(`https://${host}`, { method: 'GET', redirect: 'follow' });
                    return res.json({ status: 'ok' });
                } catch (e2) {
                    return res.json({ status: 'filtered' });
                }
            }
        }

        if (action === 'recreate') {
            if (!serviceId || !environmentId) return res.status(400).json({ error: 'serviceId+envId required' });

            // List existing TCP proxies
            try {
                const list = await rq(`query($s: String!, $e: String!) { tcpProxies(serviceId: $s, environmentId: $e) { edges { node { id } } } }`, railwayToken, { s: serviceId, e: environmentId });
                const proxies = list.data?.tcpProxies?.edges || [];
                // Delete all
                for (const p of proxies) {
                    await rq(`mutation($id: String!) { tcpProxyDelete(id: $id) }`, railwayToken, { id: p.node.id }).catch(() => {});
                }
            } catch (e) { /* ignore */ }

            await sleep(2000);

            // Create new
            const createRes = await rq(`mutation($i: ServiceDomainCreateInput!) { serviceDomainCreate(input: $i) { id domain } }`, railwayToken, {
                i: { serviceId, environmentId, targetPort: 8080 }
            });
            const domain = createRes.data.serviceDomainCreate.domain;
            return res.json({ status: 'ok', domain, port: 8080 });
        }

        return res.status(400).json({ error: 'Unknown action' });
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
