const MONITORED_SCRIPT = 'ai3-checkin';
const THRESHOLD = 800;
const DAILY_LIMIT = 1000;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndAlert(env));
  },

  async fetch(request, env) {
    await checkAndAlert(env);
    return new Response('ok');
  },
};

async function checkAndAlert(env) {
  const today = new Date().toISOString().slice(0, 10);
  const alertKey = `alert:${today}`;

  const alreadyAlerted = await env.KV.get(alertKey);
  if (alreadyAlerted) return;

  const { writes, deletes } = await queryKvUsage(env, today);

  if (writes < THRESHOLD && deletes < THRESHOLD) return;

  const text =
    `⚠️ KV 用量告警 (${MONITORED_SCRIPT})\n` +
    `日期：${today}\n` +
    `Write：${writes} / ${DAILY_LIMIT}\n` +
    `Delete：${deletes} / ${DAILY_LIMIT}\n` +
    `已達 80% 上限，請留意。`;

  await sendTelegram(env, text);
  await env.KV.put(alertKey, '1', { expirationTtl: 86400 });
}

async function queryKvUsage(env, dateStr) {
  const query = `
    query KvUsage($accountTag: String!, $date: String!, $scriptName: String!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          kvOperationsAdaptiveGroups(
            limit: 1000
            filter: {
              date: $date
              actionType_in: ["write", "delete"]
            }
          ) {
            sum { requests }
            dimensions { actionType }
          }
        }
      }
    }
  `;

  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: {
        accountTag: env.CF_ACCOUNT_ID,
        date: dateStr,
        scriptName: MONITORED_SCRIPT,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  if (data.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  const groups =
    data?.data?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups ?? [];

  let writes = 0;
  let deletes = 0;
  for (const g of groups) {
    if (g.dimensions.actionType === 'write') writes += g.sum.requests;
    else if (g.dimensions.actionType === 'delete') deletes += g.sum.requests;
  }
  return { writes, deletes };
}

async function sendTelegram(env, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Telegram HTTP ${res.status}: ${await res.text()}`);
  }
}
