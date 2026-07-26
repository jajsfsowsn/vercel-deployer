// api/tcp.js — TCP Proxy management (test, delete, recreate)

const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2';

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const { action, railwayToken, serviceId, environmentId, host, port } = req.body || {};
    if (!railwayToken) return res.status(400).json({ error: 'Railway token required' });

    try {
        if (action === 'test') {
            // Test if TCP proxy is reachable
            if (!host || !port) return res.status(400).json({ error: 'host and port required' });
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 5000);
                const r = await fetch(`https://${host}`, {
                    method: 'CONNECT',
                    signal: controller.signal
                });
                clearTimeout(timeout);
                return res.json({ status: 'ok' });
            } catch (e) {
                // Try simple fetch as fallback
                try {
                    const r = await fetch(`https://${host}`, { method: 'HEAD', redirect: 'follow' });
                    return res.json({ status: r.ok ? 'ok' : 'error' });
                } catch (e2) {
                    return res.json({ status: 'error', message: 'domain unreachable' });
                }
            }
        }

        if (action === 'list') {
            if (!serviceId || !environmentId) {
                return res.status(400).json({ error: 'serviceId and environmentId required' });
            }
            const data = await railwayQuery(`
                query($serviceId: String!, $environmentId: String!) {
                    tcpProxies(serviceId: $serviceId, environmentId: $environmentId) {
                        edges {
                            node {
                                id
                                host
                                port
                                address
                            }
                        }
                    }
                }
            `, railwayToken, { serviceId, environmentId });
            return res.json({ status: 'ok', proxies: data.data.tcpProxies?.edges || [] });
        }

        if (action === 'delete') {
            if (!req.body.proxyId) {
                return res.status(400).json({ error: 'proxyId required' });
            }
            await railwayQuery(`
                mutation($id: String!) {
                    tcpProxyDelete(id: $id)
                }
            `, railwayToken, { id: req.body.proxyId });
            return res.json({ status: 'ok' });
        }

        if (action === 'recreate') {
            // Delete old and create new TCP proxy
            if (!serviceId || !environmentId) {
                return res.status(400).json({ error: 'serviceId and environmentId required' });
            }

            // List existing
            const listData = await railwayQuery(`
                query($serviceId: String!, $environmentId: String!) {
                    tcpProxies(serviceId: $serviceId, environmentId: $environmentId) {
                        edges { node { id } }
                    }
                }
            `, railwayToken, { serviceId, environmentId });

            // Delete all existing
            const proxies = listData.data.tcpProxies?.edges || [];
            for (const p of proxies) {
                await railwayQuery(`
                    mutation($id: String!) { tcpProxyDelete(id: $id) }
                `, railwayToken, { id: p.node.id }).catch(() => {});
            }

            await sleep(2000);

            // Create new via serviceDomainCreate with port 8080
            try {
                const createResult = await railwayQuery(`
                    mutation($input: ServiceDomainCreateInput!) {
                        serviceDomainCreate(input: $input) {
                            id
                            domain
                        }
                    }
                `, railwayToken, {
                    input: {
                        serviceId,
                        environmentId,
                        targetPort: 8080
                    }
                });
                const domain = createResult.data.serviceDomainCreate.domain;
                return res.json({ status: 'ok', domain, port: 8080 });
            } catch (e) {
                return res.json({ status: 'error', error: e.message });
            }
        }

        return res.status(400).json({ error: 'Unknown action' });

    } catch (err) {
        return res.status(200).json({ status: 'error', error: err.message });
    }
};

async function railwayQuery(query, token, variables = {}) {
    const r = await fetch(RAILWAY_GQL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ query, variables })
    });
    const data = await r.json();
    if (data.errors) throw new Error(`Railway: ${data.errors[0].message}`);
    return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
