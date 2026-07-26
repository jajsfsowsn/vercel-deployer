// api/connect.js — Verify tokens + Fork repo + Connect Railway to GitHub

const SOURCE_REPO = 'jajsfsowsn/3x-ui-Upgrade';
const GITHUB_API = 'https://api.github.com';
const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2';

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const { action, githubToken, railwayToken } = req.body || {};

    try {
        // ===== Verify GitHub Token =====
        if (action === 'verify_github') {
            if (!githubToken) return res.status(400).json({ error: 'GitHub token required' });

            const user = await ghFetch('/user', githubToken);
            return res.json({
                status: 'ok',
                username: user.login,
                name: user.name || user.login,
                email: user.email
            });
        }

        // ===== Fork repo + Connect Railway =====
        if (action === 'fork_and_connect') {
            if (!githubToken) return res.status(400).json({ error: 'GitHub token required' });

            const user = await ghFetch('/user', githubToken);
            const username = user.login;

            // Check if fork already exists
            let fork;
            try {
                fork = await ghFetch(`/repos/${username}/3x-ui-Upgrade`, githubToken);
            } catch (e) {
                // Fork doesn't exist, create it
                try {
                    fork = await ghFetch(`/repos/${SOURCE_REPO}/forks`, githubToken, 'POST', {
                        name: '3x-ui-Upgrade',
                        default_branch_only: true
                    });
                } catch (e2) {
                    throw new Error('خطا در فورک کردن: ' + e2.message);
                }
            }

            // Wait for GitHub to prepare the fork
            await sleep(3000);

            // Create a deploy key so Railway can access the repo
            // (This is done later when Railway token is provided)

            return res.json({
                status: 'ok',
                forkName: `${username}/3x-ui-Upgrade`,
                username
            });
        }

        // ===== Verify Railway Token =====
        if (action === 'verify_railway') {
            if (!railwayToken) return res.status(400).json({ error: 'Railway token required' });

            const me = await railwayQuery(`query { me { id name email } }`, railwayToken);
            return res.json({
                status: 'ok',
                email: me.data.me.email,
                name: me.data.me.name
            });
        }

        return res.status(400).json({ error: 'Unknown action' });

    } catch (err) {
        return res.status(200).json({ status: 'error', error: err.message });
    }
};

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
    if (data.errors) throw new Error(`Railway: ${data.errors[0].message}`);
    return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
