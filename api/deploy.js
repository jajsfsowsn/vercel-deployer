// api/deploy.js — Deploy 3x-ui-Upgrade to Railway

const SOURCE_REPO = 'jajsfsowsn/3x-ui-Upgrade';
const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2';
const GITHUB_API = 'https://api.github.com';

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const { githubToken, railwayToken, region } = req.body || {};
    if (!githubToken || !railwayToken) return res.status(400).json({ error: 'Both tokens required' });

    // Railway regions
    const REGIONS = {
        'us-west1': 'California',
        'us-east4': 'Virginia',
        'europe-west1': 'Amsterdam',
        'asia-southeast1': 'Singapore'
    };
    const selectedRegion = REGIONS[region] ? region : 'us-west1';

    const log = [];
    const step = (msg) => log.push(msg);

    try {
        step('بررسی گیتهاب...');
        const ghUser = await ghFetch('/user', githubToken);
        const ghUsern = ghUser.login;

        step('فورک پروژه...');
        try { await ghFetch(`/repos/${ghUsern}/3x-ui-Upgrade`, githubToken); }
        catch (e) {
            await ghFetch(`/repos/${SOURCE_REPO}/forks`, githubToken, 'POST', { name: '3x-ui-Upgrade', default_branch_only: true });
        }
        await sleep(3000);
        step(`فورک: ${ghUsern}/3x-ui-Upgrade`);

        // Check GitHub App
        let repos;
        try { repos = await rq(`query { githubRepos { id } }`, railwayToken); } catch (e) { repos = null; }
        if (!repos?.data?.githubRepos?.length) {
            return res.status(200).json({
                status: 'need_github_app', error: 'GitHub App Railway نصب نیست:',
                installUrl: 'https://github.com/apps/railway-app/installations/new', log
            });
        }

        // Workspace
        const wsData = await rq(`query { me { workspaces { id } } }`, railwayToken);
        const ws = wsData.data.me.workspaces || [];
        const wsId = ws.length > 0 ? ws[0].id : null;

        // Create project
        step('ساخت پروژه...');
        const inp = { name: '3x-ui-panel', description: '3x-ui VPN Panel' };
        if (wsId) inp.workspaceId = wsId;
        const projRes = await rq(`mutation($i: ProjectCreateInput!) { projectCreate(input: $i) { id name environments { edges { node { id } } } } }`, railwayToken, { i: inp });
        const proj = projRes.data.projectCreate;
        const projId = proj.id;
        const envId = proj.environments.edges[0]?.node?.id;
        step(`پروژه: ${proj.name}`);

        // Deploy from GitHub
        step('دیپلوی از گیتهاب...');
        const depRes = await rq(`mutation($i: GitHubRepoDeployInput!) { githubRepoDeploy(input: $i) }`, railwayToken, {
            i: { projectId: projId, repo: `${ghUsern}/3x-ui-Upgrade`, branch: 'main', environmentId: envId }
        });
        step(`دیپلوی: ${depRes.data.githubRepoDeploy}`);
        await sleep(8000);

        // Get service
        step('دریافت سرویس...');
        const svcData = await rq(`query($id: String!) { project(id: $id) { services { edges { node { id } } } } }`, railwayToken, { id: projId });
        const svcs = svcData.data.project?.services?.edges || [];
        const svcId = svcs[0]?.node?.id;
        if (!svcId) throw new Error('سرویس هنوز ساخته نشده.');
        step(`سرویس: ${svcId}`);

        // Set region
        step(`تنظیم منطقه: ${REGIONS[selectedRegion]}...`);
        await rq(`mutation($sid: String!, $eid: String!, $i: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $sid, environmentId: $eid, input: $i) { id } }`, railwayToken, {
            sid: svcId, eid: envId, i: { region: selectedRegion }
        }).catch(() => {});

        // Set env vars
        step('تنظیم NGINX_PORT=3000...');
        await rq(`mutation($i: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $i) }`, railwayToken, {
            i: { projectId: projId, environmentId: envId, serviceId: svcId, variables: [{ name: 'NGINX_PORT', value: '3000' }] }
        }).catch(() => {});

        await sleep(5000);

        // Redeploy
        step('ری‌استارت...');
        await rq(`mutation($eid: String!, $sid: String!) { serviceInstanceDeploy(environmentId: $eid, serviceId: $sid) { id } }`, railwayToken, { eid: envId, sid: svcId }).catch(() => {});

        // ONLY ONE domain on port 3000 (panel)
        step('ساخت دامنه پنل (3000)...');
        const dRes = await rq(`mutation($i: ServiceDomainCreateInput!) { serviceDomainCreate(input: $i) { id domain } }`, railwayToken, {
            i: { serviceId: svcId, environmentId: envId, targetPort: 3000 }
        });
        const panelDomain = dRes.data.serviceDomainCreate.domain;
        const panelUrl = `https://${panelDomain}/managepanel/`;
        step(`پنل: ${panelUrl}`);

        // TCP Proxy info (manual creation needed)
        step('TCP Proxy: نیاز به ساخت دستی از Railway Dashboard');

        return res.status(200).json({
            status: 'ok', projectId: projId, serviceId: svcId, environmentId: envId,
            panelUrl, region: REGIONS[selectedRegion],
            tcpDashboardUrl: `https://railway.com/project/${projId}/${svcId}`,
            log
        });

    } catch (err) {
        return res.status(200).json({ status: 'error', error: err.message, log });
    }
};

async function ghFetch(path, token, method = 'GET', body = null) {
    const opts = { method, headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(`${GITHUB_API}${path}`, opts);
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
    return r.json();
}

async function rq(query, token, variables = {}) {
    const r = await fetch(RAILWAY_GQL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ query, variables }) });
    const data = await r.json();
    if (data.errors) throw new Error(`Railway: ${data.errors[0].message}`);
    return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
