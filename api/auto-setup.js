// api/auto-setup.js — Auto-setup 3x-ui panel: login + create inbound + client
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { panelUrl } = req.body || {};
  if (!panelUrl) return res.status(400).json({ error: 'panelUrl required' });

  const base = panelUrl.replace(/\/managepanel\/?$/, '').replace(/\/$/, '');
  const log = [];
  const step = (msg) => log.push(msg);

  try {
    // Wait for panel to be ready
    step('بررسی آمادگی پنل...');
    let ready = false;
    for (let i = 0; i < 12; i++) {
      try {
        const r = await fetch(`${base}/login`, { method: 'GET', redirect: 'follow' });
        if (r.ok || r.status === 200) { ready = true; break; }
      } catch (e) {}
      await sleep(5000);
    }
    if (!ready) throw new Error('پنل آماده نیست. لطفاً ۱ دقیقه صبر کنید و دوباره تلاش کنید.');
    step('پنل آماده است');

    // Login
    step('ورود به پنل...');
    const loginRes = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
      redirect: 'follow'
    });
    
    // Get cookies
    const cookies = loginRes.headers.getSetCookie?.() || [];
    const sessionCookie = cookies.find(c => c.includes('3x-ui')) || cookies[0] || '';
    const cookieValue = sessionCookie.split(';')[0];
    
    if (!cookieValue) throw new Error('ورود ناموفق بود');
    step('ورود موفق');

    const headers = { 'Cookie': cookieValue, 'Content-Type': 'application/json' };

    // Get existing inbounds
    step('بررسی Inbound های موجود...');
    const inboundsRes = await fetch(`${base}/panel/api/inbounds`, { headers });
    const inboundsData = await inboundsRes.json();
    const existingInbounds = inboundsData?.obj?.list || [];
    step(`${existingInbounds.length} Inbound موجود`);

    // Create VLESS inbound on port 443 if not exists
    let inboundId = null;
    const vlessInbound = existingInbounds.find(i => i.protocol === 'vless' && i.port === '443');
    
    if (vlessInbound) {
      inboundId = vlessInbound.id;
      step('Inbound VLESS:443 موجود');
    } else {
      step('ساخت Inbound VLESS:443...');
      const inboundBody = {
        up: 0, down: 0, total: 0,
        remark: 'MehrdadVPN',
        enable: true, expiryTime: 0, listen: '',
        port: '443',
        protocol: 'vless',
        settings: JSON.stringify({
          clients: [],
          decryption: 'none',
          fallbacks: [
            { dest: 80, xver: 1 },
            { path: '/vless', dest: 80, xver: 1 }
          ]
        }),
        streamSettings: JSON.stringify({
          network: 'ws',
          security: 'reality',
          realitySettings: {
            dest: 'www.google.com:443',
            serverNames: ['www.google.com', 'google.com'],
            privateKey: '',
            shortIds: [''],
            source: '',
            xver: 0
          },
          wsSettings: {
            path: '/vless',
            headers: { Host: 'www.google.com' }
          }
        }),
        sniffing: JSON.stringify({
          enabled: true,
          destOverride: ['http', 'tls'],
          routeOnly: false
        })
      };

      const createRes = await fetch(`${base}/panel/api/inbounds`, {
        method: 'POST', headers,
        body: JSON.stringify(inboundBody)
      });
      const createData = await createRes.json();
      
      if (!createData.success) throw new Error('خطا در ساخت Inbound: ' + (createData.msg || 'ناشناخته'));
      
      inboundId = createData.obj?.id;
      step(`Inbound ساخته شد: ${inboundId}`);
    }

    // Add client to inbound
    if (inboundId) {
      step('ساخت کاربر (Client)...');
      const clientId = Math.random().toString(36).substring(2, 10);
      const clientBody = {
        clients: [{
          id: clientId,
          email: 'user@me',
          enable: true,
          expiryTime: 0,
          flow: 'xtls-rprx-vision',
          limitIp: 0,
          subId: '',
          tgId: '',
          totalGB: 0
        }]
      };

      const clientRes = await fetch(`${base}/panel/api/inbounds/${inboundId}/client`, {
        method: 'POST', headers,
        body: JSON.stringify(clientBody)
      });
      const clientData = await clientRes.json();
      
      if (clientData.success) {
        step('کاربر ساخته شد');
      } else {
        step('خطا در ساخت کاربر: ' + (clientData.msg || 'ناشناخته'));
      }
    }

    return res.status(200).json({
      status: 'ok',
      panelUrl: base + '/managepanel/',
      inboundId,
      log
    });

  } catch (err) {
    return res.status(200).json({ status: 'error', error: err.message, log });
  }
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
