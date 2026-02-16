const fs = require('fs');
const https = require('https');

const html = fs.readFileSync('collectr.html', 'utf8');
const matches = [...html.matchAll(/src="([^"]*\/static\/chunks[^"]+)"/g)];
const urls = Array.from(new Set(matches.map(m => 'https://app.getcollectr.com' + m[1])));

const patterns = [
  '89992:',
  'cardType',
  'gradedCards',
  'searchProductViewType',
  'sortType',
  'sortOrder',
  'selectedLanguageFilters',
  'selectedCategoryFilters',
  'selectedFilters'
];

const fetch = (url) => new Promise((resolve, reject) => {
  https.get(url, {headers: {'user-agent': 'CardLobby Collectr Importer'}}, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => resolve({url, status: res.statusCode, body: data}));
  }).on('error', reject);
});

(async () => {
  const results = [];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.status !== 200) continue;
      const hits = patterns.filter(p => res.body.includes(p));
      if (hits.length) {
        results.push({url, hits});
      }
    } catch (err) {}
  }
  results.forEach(r => {
    console.log('\n', r.url);
    console.log('  hits:', r.hits.join(', '));
  });
})();
