// Demo bookmark collection for the dev preview and the store screenshots: realistic, deterministic,
// and entirely made up. Defines window.__BK_FIXTURE = { tree, visits } (same shape as `serve.py --real`).
(() => {
  const DAY = 864e5, YEAR = 365.25 * DAY;
  const now = Date.now();
  let nextId = 10;
  const profile = new Map(); // url → visit profile (see below)

  // L(title, url, years since added, visit profile)
  //   D daily · W weekly · O occasional · B recent burst · b older burst · - never
  const L = (title, url, age, p = '-') => {
    profile.set(url, p);
    return { id: String(nextId++), title, url, dateAdded: Math.round(now - age * YEAR) };
  };
  const F = (title, age, children) => ({ id: String(nextId++), title, dateAdded: Math.round(now - age * YEAR), children });

  const bar = F('Bookmarks bar', 12, [
    L('GitHub', 'https://github.com/', 9, 'D'),
    L('Calendar', 'https://calendar.google.com/calendar/u/0/r', 8, 'D'),
    L('Hacker News', 'https://news.ycombinator.com/', 10, 'D'),
    F('Work', 5, [
      L('Grafana — Production overview', 'https://grafana.example.com/d/prod-overview', 2.4, 'D'),
      L('Sentry — Issues', 'https://sentry.io/organizations/acme/issues/', 2.1, 'W'),
      L('Linear — Sprint board', 'https://linear.app/acme/team/ENG/active', 1.6, 'W'),
      L('Engineering handbook', 'https://acme.atlassian.net/wiki/spaces/ENG/overview', 3.2, 'O'),
      L('On-call runbook', 'https://acme.atlassian.net/wiki/spaces/ENG/pages/oncall', 2.8, 'O'),
      F('Projects', 2, [
        L('Search relevance — design doc', 'https://docs.google.com/document/d/search-relevance', 0.3, 'B'),
        L('Billing v2 RFC', 'https://github.com/acme/rfcs/pull/142', 0.5, 'B'),
        L('Q3 roadmap', 'https://www.notion.so/acme/Q3-roadmap', 0.4, 'O'),
        L('Load test results', 'https://grafana.example.com/d/load-test', 0.9, 'b'),
        L('Feature flags', 'https://app.launchdarkly.com/acme/production/features', 1.2, 'W'),
        L('Data pipeline — Airflow', 'https://airflow.acme.internal/home', 1.4, 'O'),
      ]),
      F('Infra', 3, [
        L('Kubernetes dashboard', 'https://k8s.acme.internal/#/workloads', 2.6, 'W'),
        L('AWS console', 'https://console.aws.amazon.com/console/home', 3.1, 'W'),
        L('Terraform registry', 'https://registry.terraform.io/browse/providers', 2.2, 'O'),
        L('Cloudflare dashboard', 'https://dash.cloudflare.com/', 1.9, 'O'),
        L('Status page', 'https://status.acme.com/', 2.9, '-'),
      ]),
      F('Onboarding 2021', 4.6, [
        L('VPN setup guide', 'https://acme.atlassian.net/wiki/spaces/IT/pages/vpn', 4.6),
        L('Laptop checklist', 'https://acme.atlassian.net/wiki/spaces/IT/pages/laptop', 4.6),
        L('Benefits portal', 'https://benefits.example.com/acme', 4.6),
        L('Expense policy', 'https://acme.atlassian.net/wiki/spaces/HR/pages/expenses', 4.5),
        L('Org chart', 'https://acme.example.com/org', 4.5),
        L('Team wiki — start here', 'https://www.notion.so/acme/Start-here', 4.5),
        L('Security training', 'https://training.example.com/acme/security', 4.4),
      ]),
    ]),
    F('Dev docs', 7, [
      L('MDN — JavaScript reference', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference', 7, 'W'),
      L('Python 3 documentation', 'https://docs.python.org/3/', 6.5, 'W'),
      L('PostgreSQL documentation', 'https://www.postgresql.org/docs/current/', 5.2, 'O'),
      L('Chrome extensions — API reference', 'https://developer.chrome.com/docs/extensions/reference/api', 0.2, 'B'),
      L('The Rust Programming Language', 'https://doc.rust-lang.org/book/', 3.4, 'b'),
      L('Kubernetes documentation', 'https://kubernetes.io/docs/home/', 3.1, 'O'),
      L('regex101', 'https://regex101.com/', 5.8, 'O'),
      L('Can I use…', 'https://caniuse.com/', 6.1, 'O'),
      L('Go by Example', 'https://gobyexample.com/', 4.2),
      L('Learn X in Y minutes', 'https://learnxinyminutes.com/', 5.5),
    ]),
    F('Reading', 8, [
      F('Articles', 6, [
        L('Things I wish I knew about Postgres', 'https://blog.example.dev/postgres-lessons', 1.1, 'b'),
        L('The log: what every engineer should know', 'https://engineering.linkedin.com/distributed-systems/log', 5.9),
        L('Choose boring technology', 'https://boringtechnology.club/', 4.8),
        L('Falsehoods programmers believe about time', 'https://infiniteundo.com/post/25326999628', 6.3),
        L('How to do great work', 'https://paulgraham.com/greatwork.html', 2.3, 'O'),
        L('Systems design primer', 'https://github.com/donnemartin/system-design-primer', 4.1, 'O'),
        L('What color is your function?', 'https://journal.stuffwithstuff.com/2015/02/01/what-color-is-your-function/', 5.4),
        L('Latency numbers every programmer should know', 'https://gist.github.com/jboner/2841832', 7.2),
        L('Write code that is easy to delete', 'https://programmingisterrible.com/post/139222674273', 5.1),
        L('The twelve-factor app', 'https://12factor.net/', 6.9),
      ]),
      F('Papers', 4, [
        L('Attention is all you need', 'https://arxiv.org/abs/1706.03762', 3.6, 'O'),
        L('Dynamo: highly available key-value store', 'https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf', 4.4),
        L('In search of an understandable consensus algorithm (Raft)', 'https://raft.github.io/raft.pdf', 4.2),
        L('Spanner: Google’s globally distributed database', 'https://research.google/pubs/pub39966/', 4.0),
      ]),
      F('Read later', 3, [
        L('A visual guide to quantization', 'https://blog.example.dev/visual-quantization', 0.6),
        L('Designing data-intensive applications — notes', 'https://www.notion.so/me/DDIA-notes', 2.4),
        L('The architecture of open source applications', 'https://aosabook.org/en/', 2.7),
        L('Crafting interpreters', 'https://craftinginterpreters.com/', 2.1, 'b'),
        L('Teach yourself computer science', 'https://teachyourselfcs.com/', 1.8),
      ]),
    ]),
    F('Tools', 6, [
      L('Excalidraw', 'https://excalidraw.com/', 3.3, 'W'),
      L('DeepL Translator', 'https://www.deepl.com/translator', 2.9, 'W'),
      L('Photopea', 'https://www.photopea.com/', 4.0, 'O'),
      L('Squoosh', 'https://squoosh.app/', 4.4, 'O'),
      L('JSON formatter', 'https://jsonformatter.org/', 5.2, 'O'),
      L('Wolfram|Alpha', 'https://www.wolframalpha.com/', 6.6),
      L('Speedtest', 'https://www.speedtest.net/', 5.9),
    ]),
  ]);

  const other = F('Other bookmarks', 12, [
    F('Home', 6, [
      F('Finance', 5, [
        L('Bank — accounts', 'https://bank.example.com/accounts', 5.1, 'W'),
        L('Tax return 2025', 'https://tax.example.gov/return/2025', 0.8, 'b'),
        L('Mortgage calculator', 'https://www.example-mortgage.com/calculator', 3.7),
        L('Pension overview', 'https://pension.example.com/overview', 2.2, 'O'),
      ]),
      F('House', 4, [
        L('Energy usage', 'https://energy.example.com/usage', 1.3, 'O'),
        L('Home insurance policy', 'https://insurance.example.com/policy', 3.0),
        L('Kitchen planner', 'https://kitchen.planner.example.com/', 2.6),
      ]),
    ]),
    F('Recipes', 5, [
      L('Shakshuka', 'https://www.seriouseats.com/shakshuka-recipe', 4.1, 'O'),
      L('Sourdough starter guide', 'https://www.theperfectloaf.com/beginners-sourdough-starter', 3.8),
      L('Thai green curry', 'https://www.recipetineats.com/thai-green-curry/', 2.9, 'O'),
      L('Weeknight ramen', 'https://www.bonappetit.com/recipe/weeknight-ramen', 1.9),
      L('Banana bread', 'https://www.kingarthurbaking.com/recipes/banana-bread-recipe', 3.3),
      L('Vietnamese pho', 'https://www.seriouseats.com/pho-recipe', 2.2),
    ]),
    F('Travel', 7, [
      F('Lisbon 2026', 0.2, [
        L('Flights', 'https://www.example-air.com/trips/LIS', 0.2, 'B'),
        L('Hotel — Alfama', 'https://www.example-hotels.com/alfama', 0.2, 'B'),
        L('Tram 28 tips', 'https://www.lisbon-guide.example/tram-28', 0.15, 'O'),
        L('Restaurants to try', 'https://www.notion.so/me/Lisbon-food', 0.1, 'B'),
      ]),
      F('Japan 2019', 7, [
        L('JR Pass', 'https://www.jrpass.com/', 7),
        L('Kyoto temples map', 'https://www.google.com/maps/d/kyoto-temples', 7),
        L('Ryokan booking', 'https://www.example-ryokan.jp/', 6.9),
        L('Tokyo food list', 'https://www.notion.so/me/Tokyo-food', 6.9),
      ]),
      F('Temp', 2, []),
    ]),
    F('Old stuff 2016', 10, [
      L('Flash game collection', 'http://games.example.com/flash', 10.2),
      L('Google Reader alternatives', 'http://lifehacker.example.com/reader-alternatives', 10.4),
      L('jQuery plugins list', 'http://plugins.jquery.com/', 10.1),
      L('Grunt vs Gulp', 'http://blog.example.com/grunt-vs-gulp', 9.9),
      L('Angular 1.5 guide', 'https://docs.angularjs.org/guide', 9.8),
      L('Parse documentation', 'http://parse.com/docs', 10.0),
      L('Bower packages', 'http://bower.io/search/', 10.3),
      L('Old portfolio', 'http://portfolio.example.com/', 9.7),
    ]),
    F('Unsorted', 3, [
      L('GitHub', 'https://github.com', 6.2),
      L('Hacker News', 'https://www.news.ycombinator.com/', 8.1),
      L('Excalidraw', 'https://excalidraw.com', 2.4),
      F('New folder', 2.5, []),
    ]),
    L('Conference talk ideas', 'https://www.notion.so/me/Talk-ideas', 0.7, 'O'),
    L('Gift ideas', 'https://www.notion.so/me/Gifts', 1.5, 'b'),
  ]);

  const mobile = F('Mobile bookmarks', 12, [
    L('Weather', 'https://weather.example.com/amsterdam', 4.0, 'W'),
    L('Train times', 'https://www.ns.nl/en/journeyplanner', 3.2, 'W'),
    L('Podcast queue', 'https://pods.example.com/queue', 1.9, 'O'),
    L('Running routes', 'https://www.strava.com/routes', 2.8),
  ]);

  bar.folderType = 'bookmarks-bar';
  other.folderType = 'other';
  mobile.folderType = 'mobile';
  for (const r of [bar, other, mobile]) r.syncing = true;
  bar.id = '1'; other.id = '2'; mobile.id = '3';
  const tree = { id: '0', title: '', children: [bar, other, mobile] };
  (function link(n) {
    (n.children || []).forEach((c, i) => { c.parentId = n.id; c.index = i; link(c); });
  })(tree);

  // ---- visits: up to ~11 months of history, shaped by each bookmark's profile ----
  const hash = (s) => { let x = 2166136261; for (const c of s) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return x >>> 0; };
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const visits = {};
  for (const [url, p] of profile) {
    if (p === '-') continue;
    let s = hash(url) || 1;
    const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
    const span = 330;
    const burstStart = p === 'B' ? 3 + Math.floor(rnd() * 30) : 90 + Math.floor(rnd() * 200);
    const burstLen = 6 + Math.floor(rnd() * 10);
    const list = [];
    for (let d = span; d >= 0; d--) {
      const weekend = new Date(midnight.getTime() - d * DAY).getDay() % 6 === 0;
      const inBurst = d <= burstStart && d > burstStart - burstLen;
      const chance = {
        D: weekend ? 0.45 : 0.92, W: weekend ? 0.08 : 0.32, O: 0.05,
        B: inBurst ? 0.85 : 0.004, b: inBurst ? 0.8 : 0.002,
      }[p];
      if (rnd() >= chance) continue;
      const n = 1 + Math.floor(rnd() * (p === 'D' ? 5 : p === 'W' ? 2 : 1.6));
      for (let i = 0; i < n; i++) {
        const t = midnight.getTime() - d * DAY + (8 + rnd() * 14) * 3600e3;
        if (t < now) list.push({ visitTime: Math.round(t), transition: rnd() < 0.04 ? 'reload' : 'link' });
      }
    }
    list.sort((a, b) => a.visitTime - b.visitTime);
    if (list.length) visits[url] = list;
  }

  window.__BK_FIXTURE = { tree, visits };
})();
