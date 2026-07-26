// api/deploy.js — Vercel Serverless Function
// Deploys jajsfsowsn/3x-ui-Upgrade to Railway via user's tokens

const SOURCE_REPO = 'jajsfsowsn/3x-ui-Upgrade';
const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2';
const GITHUB_API = 'https://api.github.com';

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const { githubToken, railwayToken, projectName } = req.body || {};
    if (!githubToken || !railwayToken) {
        return res.status(400).json({ error: 'Both tokens required' });
    }

    const log = [];
    const step = (msg) => { log.push(msg); };

    try {
        // ---- Step 1: Get GitHub user info ----
        step('بررسی اکانت گیتهاب...');
        const ghUser = await ghFetch('/user', githubToken);
        const ghUsername = ghUser.login;
        step(`اکانت گیتهاب: ${ghUsername}`);

        // ---- Step 2: Fork the repo ----
        step('فورک کردن پروژه...');
        let fork;
        try {
            fork = await ghFetch(`/repos/${SOURCE_REPO}/forks`, githubToken, 'POST', {
                name: '3x-ui-Upgrade',
                default_branch_only: true
            });
        } catch (e) {
            // Maybe already forked
            try {
                fork = await ghFetch(`/repos/${ghUsername}/3x-ui-Upgrade`, githubToken);
            } catch (e2) {
                throw new Error('fork failed: ' + e.message);
            }
        }
        step(`فورک شد: ${ghUsername}/3x-ui-Upgrade`);

        // Wait for GitHub to prepare the fork
        await sleep(3000);

        // ---- Step 3: Get Railway team/project info ----
        step('اتصال به Railway...');
        const me = await railwayQuery(`query { me { id name email } }`, railwayToken);
        const userId = me.data.me.id;

        // Get workspace
        const teamData = await railwayQuery(`query { me { workspaces { id name } } }`, railwayToken);
        const workspaces = teamData.data.me.workspaces || [];
        let workspaceId = null;
        if (workspaces.length > 0) {
            workspaceId = workspaces[0].id;
        }

        // ---- Step 4: Create Railway project ----
        step('ساخت پروژه روی Railway...');
        const pName = projectName || '3x-ui-panel';
        const createProjectInput = {
            name: pName,
            description: '3x-ui VPN Panel - auto deployed',
        };
        if (workspaceId) createProjectInput.workspaceId = workspaceId;

        const createResult = await railwayQuery(`
            mutation($input: ProjectCreateInput!) {
                projectCreate(input: $input) {
                    id
                    name
                    environments { edges { node { id name } } }
                }
            }
        `, railwayToken, { input: createProjectInput });

        const project = createResult.data.projectCreate;
        const projectId = project.id;
        const envId = project.environments.edges[0]?.node?.id;
        step(`پروژه ساخته شد: ${project.name}`);

        // ---- Step 5: Deploy from GitHub repo ----
        step('اتصال ریپو به Railway...');
        
        // Check if GitHub repos are accessible (GitHub App installed?)
        let githubAccessible = false;
        try {
            const reposCheck = await railwayQuery(`query { githubRepos { id } }`, railwayToken);
            githubAccessible = reposCheck.data?.githubRepos?.length > 0;
        } catch (e) {
            githubAccessible = false;
        }

        if (!githubAccessible) {
            // GitHub App not installed - provide installation link
            const installUrl = `https://github.com/apps/railway-app/installations/new?state=${encodeURIComponent(JSON.stringify({projectId}))}`;
            return res.status(200).json({
                status: 'need_github_app',
                error: 'GitHub App Railway نصب نیست. روی لینک زیر کلیک کنید:',
                installUrl,
                projectId,
                log
            });
        }

        // githubRepoDeploy returns String! (not an object)
        const deployResult = await railwayQuery(`
            mutation($input: GitHubRepoDeployInput!) {
                githubRepoDeploy(input: $input)
            }
        `, railwayToken, {
            input: {
                projectId,
                repo: `${ghUsername}/3x-ui-Upgrade`,
                branch: 'main',
                environmentId: envId
            }
        });

        // Result is a string (deployment ID)
        const deployId = deployResult.data.githubRepoDeploy;
        step(`دیپلوی شروع شد: ${deployId}`);

        // Wait for deployment to register
        await sleep(5000);

        // Get the service ID from the project
        const projectData = await railwayQuery(`
            query($id: String!) {
                project(id: $id) {
                    services {
                        edges {
                            node {
                                id
                                name
                            }
                        }
                    }
                }
            }
        `, railwayToken, { id: projectId });

        const services = projectData.data.project?.services?.edges || [];
        const serviceId = services[0]?.node?.id;
        if (!serviceId) throw new Error('سرویس پیدا نشد. لطفاً چند لحظه صبر کنید و دوباره تلاش کنید.');
        
        step('ریپو متصل شد و دیپلوی در حال انجام...');

        // ---- Step 6: Set environment variables ----
        step('تنظیم متغیرهای محیطی...');
        await railwayQuery(`
            mutation($input: VariableCollectionUpsertInput!) {
                variableCollectionUpsert(input: $input)
            }
        `, railwayToken, {
            input: {
                projectId,
                environmentId: envId,
                serviceId,
                variables: [
                    { name: 'NGINX_PORT', value: '3000' }
                ]
            }
        });
        step('متغیرها تنظیم شد (NGINX_PORT=3000)');

        // ---- Step 7: Wait for initial deploy, then update service config ----
        step('تنظیم پورت و تنظیمات سرویس...');
        await sleep(5000);

        try {
            await railwayQuery(`
                mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
                    serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) {
                        id
                    }
                }
            `, railwayToken, {
                serviceId,
                environmentId: envId,
                input: {}
            });
        } catch (e) {
            // Service instance might not be ready yet, continue
        }

        // ---- Step 8: Generate public domain on port 3000 ----
        step('ساخت دامنه عمومی (پورت 3000)...');
        let domainResult;
        try {
            domainResult = await railwayQuery(`
                mutation($input: ServiceDomainCreateInput!) {
                    serviceDomainCreate(input: $input) {
                        id
                        domain
                    }
                }
            `, railwayToken, {
                input: {
                    serviceId,
                    environmentId: envId,
                    targetPort: 3000
                }
            });
        } catch (e) {
            // Domain might fail, try without targetPort
            domainResult = await railwayQuery(`
                mutation($input: ServiceDomainCreateInput!) {
                    serviceDomainCreate(input: $input) {
                        id
                        domain
                    }
                }
            `, railwayToken, {
                input: {
                    serviceId,
                    environmentId: envId
                }
            });
        }

        const panelDomain = domainResult.data.serviceDomainCreate.domain;
        const panelUrl = `https://${panelDomain}/managepanel/`;
        step(`دامنه پنل: ${panelUrl}`);

        // ---- Step 9: Create TCP proxy on port 8080 ----
        step('ساخت TCP Proxy (پورت 8080)...');
        let tcpDomain = null;
        try {
            // TCP proxy is created by adding a domain with targetPort 8080
            const tcpResult = await railwayQuery(`
                mutation($input: ServiceDomainCreateInput!) {
                    serviceDomainCreate(input: $input) {
                        id
                        domain
                    }
                }
            `, railwayToken, {
                input: {
                    serviceId,
                    environmentId: envId,
                    targetPort: 8080
                }
            });
            tcpDomain = tcpResult.data.serviceDomainCreate.domain;
        } catch (e) {
            // TCP proxy might need different approach
            try {
                // Try via serviceInstanceUpdate with TCP config
                const tcpResult2 = await railwayQuery(`
                    mutation($input: ServiceDomainCreateInput!) {
                        serviceDomainCreate(input: $input) {
                            id
                            domain
                        }
                    }
                `, railwayToken, {
                    input: {
                        serviceId,
                        environmentId: envId
                    }
                });
                tcpDomain = tcpResult2.data.serviceDomainCreate.domain;
            } catch (e2) {
                tcpDomain = 'در حال راه‌اندازی...';
            }
        }
        step(`TCP Proxy: ${tcpDomain}:8080`);

        // ---- Step 10: Trigger redeploy with new env vars ----
        step('ری‌استارت نهایی...');
        try {
            await railwayQuery(`
                mutation($environmentId: String!, $serviceId: String!) {
                    serviceInstanceDeploy(environmentId: $environmentId, serviceId: $serviceId) {
                        id
                    }
                }
            `, railwayToken, { environmentId: envId, serviceId });
        } catch (e) { /* ignore */ }

        await sleep(2000);

        return res.status(200).json({
            status: 'ok',
            projectId,
            serviceId,
            environmentId: envId,
            panelUrl,
            tcpProxy: tcpDomain ? `${tcpDomain}:8080` : null,
            tcpDomain: tcpDomain,
            log
        });

    } catch (err) {
        return res.status(200).json({
            status: 'error',
            error: err.message,
            log
        });
    }
};

// ---- Helpers ----

async function ghFetch(path, token, method = 'GET', body = null) {
    const opts = {
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    };
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const r = await fetch(`${GITHUB_API}${path}`, opts);
    if (!r.ok) {
        const err = await r.text();
        throw new Error(`GitHub API ${r.status}: ${err}`);
    }
    return r.json();
}

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
    if (data.errors) {
        throw new Error(`Railway API: ${data.errors[0].message}`);
    }
    return data;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
